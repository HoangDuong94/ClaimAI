#!/usr/bin/env node

/**
 * Adds synthetic EXIF metadata (stored in PNG eXIf chunks) to the mock images.
 *
 * Usage: node scripts/add-exif-to-png.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TARGETS = [
  {
    file: 'MockDaten/download.png',
    metadata: {
      Make: 'MockCam Industries',
      Model: 'ParkingGuard 3000',
      DateTime: '2025:09:29 18:30:00',
      DateTimeOriginal: '2025:09:29 18:30:00'
    }
  },
  {
    file: 'MockDaten/Generated Image October 10, 2025 - 8_30PM.png',
    metadata: {
      Make: 'StreetView Labs',
      Model: 'DamageVision v2',
      DateTime: '2025:10:10 20:30:00',
      DateTimeOriginal: '2025:10:10 20:30:00'
    }
  }
];

const TAGS = {
  Make: 0x010f,
  Model: 0x0110,
  DateTime: 0x0132,
  DateTimeOriginal: 0x9003
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const buildExifPayload = (metadata) => {
  const entries = [];
  const dataBlocks = [];

  const keys = Object.keys(metadata).filter((key) => TAGS[key]);
  const entryCount = keys.length;

  const headerSize = 6; // "Exif\0\0"
  const tiffHeaderSize = 8; // II + 0x2A + offset
  const ifdEntryAreaSize = 2 + entryCount * 12 + 4; // count + entries + next offset
  let nextDataOffset = tiffHeaderSize + ifdEntryAreaSize; // relative to TIFF header

  for (const key of keys) {
    const value = `${metadata[key]}\0`;
    const valueBuffer = Buffer.from(value, 'ascii');
    const entry = Buffer.alloc(12);
    entry.writeUInt16LE(TAGS[key], 0);
    entry.writeUInt16LE(2, 2); // ASCII
    entry.writeUInt32LE(valueBuffer.length, 4);
    entry.writeUInt32LE(nextDataOffset, 8);

    dataBlocks.push({ offset: nextDataOffset, buffer: valueBuffer });
    nextDataOffset += valueBuffer.length;
    entries.push(entry);
  }

  const totalSize = headerSize + tiffHeaderSize + ifdEntryAreaSize + dataBlocks.reduce((acc, block) => acc + block.buffer.length, 0);
  const payload = Buffer.alloc(totalSize);

  let cursor = 0;
  payload.write('Exif\0\0', cursor, 'ascii');
  cursor += headerSize;

  payload.write('II', cursor, 'ascii'); // little endian
  cursor += 2;
  payload.writeUInt16LE(42, cursor); // TIFF magic number
  cursor += 2;
  payload.writeUInt32LE(8, cursor); // offset to first IFD from TIFF header start
  cursor += 4;

  payload.writeUInt16LE(entryCount, cursor);
  cursor += 2;

  for (const entry of entries) {
    entry.copy(payload, cursor);
    cursor += entry.length;
  }

  payload.writeUInt32LE(0, cursor); // next IFD offset = 0
  cursor += 4;

  for (const block of dataBlocks) {
    const absoluteOffset = headerSize + block.offset;
    block.buffer.copy(payload, absoluteOffset);
  }

  return payload;
};

const parsePngChunks = (buffer) => {
  if (!buffer.slice(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Ungültige PNG-Datei');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error('PNG-Chunks fehlerhaft');
    }
    const data = buffer.subarray(dataStart, dataEnd);
    chunks.push({ type, data });
    offset = dataEnd + 4;
  }
  return chunks;
};

const serializeChunk = (type, data) => {
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crcInput = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
};

const insertExifChunk = (buffer, payload) => {
  const chunks = parsePngChunks(buffer).filter((chunk) => chunk.type !== 'eXIf');
  const builtChunks = [];
  let inserted = false;
  for (const chunk of chunks) {
    builtChunks.push(serializeChunk(chunk.type, chunk.data));
    if (!inserted && chunk.type === 'IHDR') {
      builtChunks.push(serializeChunk('eXIf', payload));
      inserted = true;
    }
  }
  if (!inserted) {
    throw new Error('IHDR-Chunk nicht gefunden; PNG beschädigt?');
  }
  return Buffer.concat([PNG_SIGNATURE, ...builtChunks]);
};

async function main() {
  for (const target of TARGETS) {
    const absolute = path.resolve(process.cwd(), target.file);
    const pngBuffer = await readFile(absolute);
    const exifPayload = buildExifPayload(target.metadata);
    const updated = insertExifChunk(pngBuffer, exifPayload);
    await writeFile(absolute, updated);
    console.log(`EXIF zu "${target.file}" hinzugefügt (${Object.keys(target.metadata).length} Felder).`);
  }
}

main().catch((error) => {
  console.error('Fehler beim Hinzufügen der EXIF-Daten:', error);
  process.exit(1);
});
