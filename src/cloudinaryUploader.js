import { v2 as cloudinary } from 'cloudinary';

const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Uploads an image buffer under a deterministic public ID. With overwrite disabled, retrying
 * the same upload returns the asset that already exists instead of creating a duplicate.
 */
export function createCloudinaryUploader({ cloudName, apiKey, apiSecret }, { client = cloudinary } = {}) {
  return async function uploadImage({ buffer, mimeType, folder, publicId }) {
    const result = await client.uploader.upload(`data:${mimeType};base64,${buffer.toString('base64')}`, {
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      folder,
      public_id: publicId,
      resource_type: 'image',
      overwrite: false,
      unique_filename: false,
      use_filename: false,
      timeout: UPLOAD_TIMEOUT_MS,
    });
    if (typeof result?.secure_url !== 'string' || !result.secure_url.startsWith('https://')) {
      throw new Error('Cloudinary did not return a secure image URL.');
    }
    return result.secure_url;
  };
}
