export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ApiError {
  error?: {
    code: string;
    message: string;
  };
}

export async function apiGet<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(path, {
    headers: authHeaders(apiKey)
  });

  return readResponse<T>(response);
}

export async function apiPostPublic<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return readResponse<T>(response);
}

export async function apiPost<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return readResponse<T>(response);
}

export async function apiPatch<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: {
      ...authHeaders(apiKey),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return readResponse<T>(response);
}

export async function apiDelete(path: string, apiKey: string): Promise<void> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: authHeaders(apiKey)
  });

  if (!response.ok) {
    await readResponse(response);
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`
  };
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & ApiError;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? response.statusText);
  }

  return payload;
}
