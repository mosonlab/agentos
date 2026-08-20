export type FrontmatterDocument = { attributes: Record<string, string>; body: string };

export const parsePromptDocument = (source: string, filePath: string): FrontmatterDocument => {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${filePath} must start with frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${filePath} has unterminated frontmatter`);
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${filePath} has invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (key in attributes) throw new Error(`${filePath} has duplicate frontmatter key ${key}`);
    attributes[key] = line.slice(separator + 1).trim();
  }
  return { attributes, body: normalized.slice(end + 5).trim() };
};

export const requiredFrontmatter = (document: FrontmatterDocument, key: string, filePath: string): string => {
  const value = document.attributes[key];
  if (!value) throw new Error(`${filePath} is missing ${key}`);
  return value;
};

export const parseInlineList = (value: string | undefined, filePath: string, key: string): string[] => {
  if (value === undefined) throw new Error(`${filePath} is missing ${key}`);
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`${filePath} ${key} must be an inline list`);
  const content = value.slice(1, -1).trim();
  return content === "" ? [] : content.split(",").map((item) => item.trim()).filter(Boolean);
};
