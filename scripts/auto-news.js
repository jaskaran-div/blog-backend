import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAutoNewsService } from '../src/autoNewsService.js';
import { createCloudinaryUploader } from '../src/cloudinaryUploader.js';
import { loadAutoNewsConfig, loadDatabaseConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { createGmailClient } from '../src/gmailClient.js';

const USAGE = `Usage:
  npm run auto-news -- import [--dry-run]   Check Gmail now (ignores the IST window)
      [--message <gmail-id>]                Process only this Gmail message
      [--upload-images]                     With --dry-run: also upload inline images to Cloudinary
  npm run auto-news -- list                 Show the 20 most recent imported emails
  npm run auto-news -- preview <slug>       Write the stored HTML to backend/preview/<slug>.html
  npm run auto-news -- publish <slug>       Publish a draft to News & Insights
  npm run auto-news -- unpublish <slug>     Move a published post back to draft
  npm run auto-news -- retry <slug>         Reset attempts on a failed import so the next check retries it`;

const [command, ...rest] = process.argv.slice(2);
const slug = rest.find((argument) => !argument.startsWith('--'));
const needsCredentials = command === 'import';
const autoNews = loadAutoNewsConfig(process.env, { requireCredentials: needsCredentials });
const pool = createDatabase(loadDatabaseConfig());
const service = createAutoNewsService({
  pool,
  config: autoNews,
  gmail: needsCredentials ? createGmailClient(autoNews.gmail) : null,
  uploadImage: needsCredentials ? createCloudinaryUploader(autoNews.cloudinary) : null,
});

function requireSlug() {
  if (!slug) throw new Error(USAGE);
  return slug;
}

try {
  switch (command) {
    case 'import': {
      const dryRun = rest.includes('--dry-run');
      const uploadImages = rest.includes('--upload-images');
      if (uploadImages && !dryRun) throw new Error('--upload-images only applies with --dry-run.');
      const messageFlag = rest.indexOf('--message');
      const messageId = messageFlag >= 0 ? rest[messageFlag + 1] : undefined;
      if (messageFlag >= 0 && !messageId) throw new Error(USAGE);
      const result = await service.runImport({ trigger: 'manual', force: true, dryRun, uploadImages, messageId });
      if (dryRun) {
        // Full HTML goes to a local file (git-ignored) rather than the terminal.
        const directory = new URL('../preview/', import.meta.url);
        await mkdir(directory, { recursive: true });
        for (const item of result.results) {
          if (typeof item.html !== 'string') continue;
          const file = new URL(`dry-run-${item.messageId}.html`, directory);
          await writeFile(file, `<!doctype html><meta charset="utf-8"><title>${item.title.replace(/</g, '&lt;')}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px}img,table{max-width:100%;height:auto}</style>
<p style="color:#64748b">DRY RUN · not saved · ${item.publishedAt.toISOString()}</p>
<h1>${item.title.replace(/</g, '&lt;')}</h1>
${item.html}`, 'utf8');
          item.html = `(${item.htmlLength} chars) written to ${fileURLToPath(file)}`;
        }
      }
      console.info(JSON.stringify(result, null, 2));
      if (!dryRun && !autoNews.autoPublish) {
        console.info('AUTO_NEWS_AUTO_PUBLISH is false: new imports are drafts. Preview, then run publish <slug>.');
      }
      break;
    }
    case 'list':
      console.table((await service.listRecent()).map((row) => ({
        slug: row.slug,
        status: row.status,
        attempts: row.attempts,
        images: row.image_count,
        links: row.link_count,
        publishedAt: new Date(row.published_at).toISOString(),
        error: row.last_error ?? '',
      })));
      break;
    case 'preview': {
      const post = await service.getBySlug(requireSlug());
      if (!post) throw new Error(`No automated news post with slug ${slug}.`);
      const directory = new URL('../preview/', import.meta.url);
      await mkdir(directory, { recursive: true });
      const file = new URL(`${post.slug}.html`, directory);
      await writeFile(file, `<!doctype html><meta charset="utf-8"><title>${post.title.replace(/</g, '&lt;')}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px}img,table{max-width:100%;height:auto}</style>
<p style="color:#64748b">Status: ${post.status} · ${new Date(post.published_at).toISOString()}</p>
<h1>${post.title.replace(/</g, '&lt;')}</h1>
${post.html_content}`, 'utf8');
      console.info(`Preview written to ${fileURLToPath(file)}`);
      break;
    }
    case 'publish':
      console.info(await service.setStatus(requireSlug(), ['draft'], 'published') ?? 'No draft with that slug.');
      break;
    case 'unpublish':
      console.info(await service.setStatus(requireSlug(), ['published'], 'draft') ?? 'No published post with that slug.');
      break;
    case 'retry':
      console.info(await service.resetAttempts(requireSlug()) ?? 'No failed import with that slug.');
      break;
    default:
      throw new Error(USAGE);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
