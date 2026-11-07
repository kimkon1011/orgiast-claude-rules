import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GRAPH_BASE = 'https://graph.instagram.com/v21.0';

export const DEFAULT_ENV_PATH = process.env.LAHAINA_IG_ENV || path.join(os.homedir(), 'lahaina-instagram', '.env');

export function parseEnvValue(text, key) {
  if (!text) return '';
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === key) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return '';
}

export function readEnvFile(envPath, fsImpl = fs) {
  try {
    const content = fsImpl.readFileSync(envPath, 'utf8');
    return {
      INSTAGRAM_ACCESS_TOKEN: parseEnvValue(content, 'INSTAGRAM_ACCESS_TOKEN'),
      INSTAGRAM_USER_ID: parseEnvValue(content, 'INSTAGRAM_USER_ID'),
      INSTAGRAM_USERNAME: parseEnvValue(content, 'INSTAGRAM_USERNAME'),
    };
  } catch {
    return {
      INSTAGRAM_ACCESS_TOKEN: '',
      INSTAGRAM_USER_ID: '',
      INSTAGRAM_USERNAME: '',
    };
  }
}

export class IgApiError extends Error {
  constructor({ message, status, code, subcode, body }) {
    super(message);
    this.name = 'IgApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.body = body;
  }
}

export async function callGraph({
  path: requestPath,
  method = 'GET',
  params = {},
  accessToken,
  fetchImpl = globalThis.fetch,
  base = GRAPH_BASE,
}) {
  const isFullUrl = requestPath.startsWith('http://') || requestPath.startsWith('https://');
  const normalizedPath = isFullUrl
    ? requestPath
    : `${base.replace(/\/+$/, '')}/${requestPath.replace(/^\/+/, '')}`;
  const url = new URL(normalizedPath);

  const queryParams = new URLSearchParams(url.search);
  const bodyParams = new URLSearchParams();

  if (accessToken && !params.access_token) {
    if (method.toUpperCase() === 'GET') {
      queryParams.set('access_token', accessToken);
    } else {
      bodyParams.set('access_token', accessToken);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (method.toUpperCase() === 'GET') {
      queryParams.set(key, String(value));
    } else {
      bodyParams.set(key, String(value));
    }
  }

  url.search = queryParams.toString();

  const fetchOptions = {
    method: method.toUpperCase(),
  };

  if (method.toUpperCase() !== 'GET') {
    fetchOptions.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    fetchOptions.body = bodyParams.toString();
  }

  const response = await fetchImpl(url.toString(), fetchOptions);
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.error) {
    const errorObj = body?.error || {};
    const message =
      errorObj.message ||
      errorObj.error_user_msg ||
      (body ? JSON.stringify(body) : `HTTP ${response.status} ${response.statusText}`);
    throw new IgApiError({
      message,
      status: response.status,
      code: errorObj.code,
      subcode: errorObj.error_subcode,
      body,
    });
  }

  return body;
}

export async function resolveUserId({ accessToken, fetchImpl = globalThis.fetch }) {
  const data = await callGraph({
    path: '/me',
    params: { fields: 'user_id,username' },
    accessToken,
    fetchImpl,
  });
  return {
    userId: data.user_id || data.id,
    username: data.username || '',
  };
}

export async function createMediaContainer({
  igUserId,
  mediaType = 'IMAGE',
  url,
  caption,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  const params = {};
  if (mediaType === 'IMAGE') {
    params.image_url = url;
  } else {
    params.video_url = url;
    params.media_type = mediaType;
  }
  if (caption) {
    params.caption = caption;
  }
  const result = await callGraph({
    path: `/${igUserId}/media`,
    method: 'POST',
    params,
    accessToken,
    fetchImpl,
  });
  return { containerId: result.id };
}

export async function getContainerStatus({
  containerId,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  const result = await callGraph({
    path: `/${containerId}`,
    method: 'GET',
    params: { fields: 'status_code,status' },
    accessToken,
    fetchImpl,
  });
  return { statusCode: result.status_code, status: result.status };
}

export async function waitForContainer({
  containerId,
  accessToken,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 30,
  intervalMs = 5000,
  onPoll,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const statusData = await getContainerStatus({ containerId, accessToken, fetchImpl });
    onPoll?.({ ...statusData, attempt, maxAttempts });

    if (statusData.statusCode === 'FINISHED') {
      return statusData;
    }
    if (statusData.statusCode === 'ERROR' || statusData.statusCode === 'EXPIRED') {
      throw new IgApiError({
        message: `Container ${containerId} failed with status: ${statusData.statusCode}`,
        status: 400,
        body: statusData,
      });
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  throw new Error(`Container ${containerId} did not finish within ${maxAttempts} attempts`);
}

export async function publishContainer({
  igUserId,
  creationId,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  const result = await callGraph({
    path: `/${igUserId}/media_publish`,
    method: 'POST',
    params: { creation_id: creationId },
    accessToken,
    fetchImpl,
  });
  return { mediaId: result.id };
}

export async function getMediaPermalink({
  mediaId,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  const result = await callGraph({
    path: `/${mediaId}`,
    method: 'GET',
    params: { fields: 'id,permalink,media_type,timestamp' },
    accessToken,
    fetchImpl,
  });
  return result;
}

export async function postToInstagram({
  igUserId,
  mediaType = 'IMAGE',
  url,
  caption,
  accessToken,
  fetchImpl = globalThis.fetch,
  sleep,
  onEvent,
}) {
  onEvent?.({ step: 'create_container', igUserId, mediaType, url });
  const { containerId } = await createMediaContainer({
    igUserId,
    mediaType,
    url,
    caption,
    accessToken,
    fetchImpl,
  });
  onEvent?.({ step: 'container_created', containerId });

  if (mediaType !== 'IMAGE') {
    onEvent?.({ step: 'waiting_container', containerId });
    await waitForContainer({
      containerId,
      accessToken,
      fetchImpl,
      sleep,
      onPoll: (s) => onEvent?.({ step: 'container_poll', ...s }),
    });
  }

  onEvent?.({ step: 'publishing', containerId });
  const { mediaId } = await publishContainer({
    igUserId,
    creationId: containerId,
    accessToken,
    fetchImpl,
  });
  onEvent?.({ step: 'published', mediaId });

  const mediaData = await getMediaPermalink({ mediaId, accessToken, fetchImpl });
  onEvent?.({ step: 'permalink_retrieved', permalink: mediaData.permalink });

  return { mediaId, permalink: mediaData.permalink, containerId };
}
