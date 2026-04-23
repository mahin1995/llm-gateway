type LogFieldValue = string | number | boolean | null | undefined;

export function stringifyForLog(value: unknown, maxLength = 4000): string {
  try {
    const serialized = JSON.stringify(value);

    if (!serialized) {
      return "";
    }

    if (serialized.length <= maxLength) {
      return serialized;
    }

    return `${serialized.slice(0, maxLength)}...<truncated>`;
  } catch {
    return "[unserializable]";
  }
}

export function logInfo(scope: string, message: string, fields?: Record<string, LogFieldValue>): void {
  writeLog("INFO", scope, message, fields);
}

export function logWarn(scope: string, message: string, fields?: Record<string, LogFieldValue>): void {
  writeLog("WARN", scope, message, fields);
}

export function logError(scope: string, message: string, fields?: Record<string, LogFieldValue>): void {
  writeLog("ERROR", scope, message, fields);
}

function writeLog(
  level: "INFO" | "WARN" | "ERROR",
  scope: string,
  message: string,
  fields?: Record<string, LogFieldValue>
): void {
  const parts = [
    `[${new Date().toISOString()}]`,
    `[${level}]`,
    `[${scope}]`,
    message
  ];

  const serializedFields = serializeFields(fields);

  if (serializedFields) {
    parts.push(serializedFields);
  }

  console.log(parts.join(" "));
}

function serializeFields(fields?: Record<string, LogFieldValue>): string {
  if (!fields) {
    return "";
  }

  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}
