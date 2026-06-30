import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";

const maxBytes = 50 * 1024;
const filePath = "dist/index.mjs";
const file = readFileSync(filePath);
const gzipSize = gzipSync(file).byteLength;
const rawSize = statSync(filePath).size;

console.log(`core raw size: ${rawSize} bytes`);
console.log(`core gzip size: ${gzipSize} bytes`);

if (gzipSize > maxBytes) {
  throw new Error(`Bundle too large: ${gzipSize} bytes gzip > ${maxBytes}`);
}
