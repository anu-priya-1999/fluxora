import { gzipSync } from "node:zlib";

export interface TarFixtureEntry {
  name: string;
  body?: Buffer;
  typeFlag?: string;
}

export function gzipTar(entries: TarFixtureEntry[]): Buffer {
  return gzipSync(createTar(entries));
}

export function createTar(entries: TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = [];

  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    const name = entry.name.slice(0, 100);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write(`${octal(body.length, 11)}\0`, 124, "utf8");
    header.write(`${octal(Math.floor(Date.now() / 1000), 11)}\0`, 136, "utf8");
    header.write("        ", 148, "utf8");
    const typeFlag =
      entry.typeFlag ?? (name.endsWith("/") ? "5" : "0");
    header.write(typeFlag, 156, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");

    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      sum += header[i] ?? 0;
    }
    header.write(`${octal(sum, 6)}\0 `, 148, "utf8");

    parts.push(header);
    if (body.length > 0) {
      parts.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) {
        parts.push(Buffer.alloc(pad));
      }
    }
  }

  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}
