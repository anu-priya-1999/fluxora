function validateSegment(name: string, value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${name} is required`);
  }

  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error(`${name} contains an invalid path segment`);
  }

  return trimmed;
}

function validateObjectName(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("objectName is required");
  }

  if (trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error("objectName must be a relative path");
  }

  const segments = trimmed.split("/");

  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    throw new Error("objectName contains an invalid path");
  }

  return segments.join("/");
}

export function snapshotObjectKey(
  organizationId: string,
  repositoryId: string,
  snapshotId: string,
  objectName: string,
): string {
  const org = validateSegment("organizationId", organizationId);
  const repo = validateSegment("repositoryId", repositoryId);
  const snapshot = validateSegment("snapshotId", snapshotId);
  const object = validateObjectName(objectName);

  return `${org}/${repo}/${snapshot}/${object}`;
}