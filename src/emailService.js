import {
  GetSendQuotaCommand,
  SESClient,
  SendEmailCommand,
} from '@aws-sdk/client-ses';

const THROTTLE_CODES = new Set([
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
]);

function isThrottleError(error) {
  return THROTTLE_CODES.has(error?.name) || THROTTLE_CODES.has(error?.Code);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createEmailService(config, client = new SESClient({
  region: config.awsRegion,
  ...(config.awsAccessKeyId && config.awsSecretAccessKey
    ? {
      credentials: {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey,
        ...(config.awsSessionToken ? { sessionToken: config.awsSessionToken } : {}),
      },
    }
    : {}),
})) {
  async function sendEmail({ to, subject, html, text }) {
    const command = new SendEmailCommand({
      Source: config.sesFromEmail,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
      ...(config.sesConfigurationSet
        ? { ConfigurationSetName: config.sesConfigurationSet }
        : {}),
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await client.send(command);
      } catch (error) {
        if (!isThrottleError(error) || attempt === 3) {
          throw error;
        }
        await delay(250 * (2 ** attempt));
      }
    }

    throw new Error('SES email send exhausted its retry attempts.');
  }

  async function verifyConnection() {
    return client.send(new GetSendQuotaCommand({}));
  }

  return { sendEmail, verifyConnection };
}
