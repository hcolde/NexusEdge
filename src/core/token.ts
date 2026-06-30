export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else if (code <= 0x007f) {
      ascii += 1;
    } else {
      other += 1;
    }
  }

  return Math.max(1, Math.ceil(ascii / 4 + cjk * 1.1 + other / 2));
}

export function estimateMessageTokens(role: string, content: string): number {
  return estimateTokens(`${role}:\n${content}`) + 4;
}
