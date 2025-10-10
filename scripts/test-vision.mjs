#!/usr/bin/env node

/**
 * Standalone script to validate GPT-4.1 vision support via AzureOpenAiChatClient.
 * - Generates a short description of a damage photo using multimodal input.
 * - Extracts available EXIF metadata (PNG eXIf chunks) without external deps.
 *
 * Usage: node scripts/test-vision.mjs [relative/path/to/image.png]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const DEFAULT_IMAGE = 'MockDaten/download.png';
const DOTENV_PATH = path.resolve(process.cwd(), '.env');

const TAG_NAMES = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8769: 'ExifIFDPointer',
  0x8825: 'GPSInfoIFDPointer',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa406: 'SceneCaptureType',
  0xa401: 'CustomRendered'
};

const TYPE_SIZES = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8 // SRATIONAL
};

const formatNumberArray = (arr) => Array.isArray(arr) ? arr.map((v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v)) : arr;

await loadEnvFromFile(DOTENV_PATH);
await main();

async function loadEnvFromFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    raw
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .forEach((line) => {
        const idx = line.indexOf('=');
        if (idx === -1) return;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) {
          process.env[key] = value;
        }
      });
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('Konnte .env nicht laden:', error.message || error);
    }
  }
}

async function main() {
  try {
    const imagePath = path.resolve(process.cwd(), process.argv[2] || DEFAULT_IMAGE);
    const imageBuffer = await readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const exifData = extractExifMetadata(imageBuffer);
    console.log('--- Local EXIF metadata (best effort) ---');
    if (exifData && Object.keys(exifData).length > 0) {
      console.dir(exifData, { depth: null });
    } else {
      console.log('Keine EXIF-Daten gefunden.');
    }

    const systemMessage = new SystemMessage({
      content: 'Du analysierst Schadenfotos und antwortest kompakt auf Deutsch.'
    });

    const humanMessage = new HumanMessage({
      content: [
        {
          type: 'text',
          text: 'Beschreibe den sichtbaren Schaden in höchstens drei Sätzen. Falls erkennbar: Fahrzeugtyp, betroffene Bauteile, Umfeld. Ziehe keine EXIF-Daten heran.'
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`
          }
        }
      ]
    });

    const visionClient = new AzureOpenAiChatClient({
      modelName: 'gpt-4.1',
      max_tokens: 300
    });

    console.log('\n--- GPT-4.1 Vision response ---');
    const response = await visionClient.invoke([systemMessage, humanMessage]);
    if (Array.isArray(response.content)) {
      response.content.forEach((entry) => {
        if (entry.type === 'text') {
          console.log(entry.text);
        } else {
          console.dir(entry);
        }
      });
    } else {
      console.log(response.content);
    }
  } catch (error) {
    console.error('Vision-Test fehlgeschlagen:', error);
    process.exitCode = 1;
  }
}

function extractExifMetadata(buffer) {
  if (!isPng(buffer)) {
    return {};
  }
  const exifChunk = readPngExifChunk(buffer);
  if (!exifChunk) {
    return {};
  }
  return parseExifBuffer(exifChunk);
}

function isPng(buffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer.slice(0, 8).equals(pngSignature);
}

function readPngExifChunk(buffer) {
  let offset = 8; // skip PNG signature
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break;
    if (type === 'eXIf') {
      return buffer.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + 4; // move past CRC
  }
  return null;
}

function parseExifBuffer(buffer) {
  if (!buffer || buffer.length < 12) {
    return {};
  }
  const header = buffer.toString('ascii', 0, 4);
  if (header !== 'Exif') {
    return {};
  }
  const tiffBase = 6;
  const endianMarker = buffer.toString('ascii', tiffBase, tiffBase + 2);
  const littleEndian = endianMarker === 'II';

  const readUInt16 = (offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const readInt32 = (offset) => (littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset));
  const readUInt32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));

  const data = {};
  const firstIfdOffset = readUInt32(tiffBase + 4);
  processIfd(tiffBase + firstIfdOffset, 'IFD0');
  return data;

  function processIfd(offset, section) {
    if (!offset || offset < tiffBase || offset >= buffer.length) {
      return;
    }
    if (offset + 2 > buffer.length) {
      return;
    }
    const entryCount = readUInt16(offset);
    let cursor = offset + 2;
    if (entryCount === 0 || cursor + entryCount * 12 > buffer.length) {
      return;
    }
    const sectionData = data[section] || (data[section] = {});

    for (let i = 0; i < entryCount; i++, cursor += 12) {
      const tag = readUInt16(cursor);
      const type = readUInt16(cursor + 2);
      const count = readUInt32(cursor + 4);
      const valueOffset = cursor + 8;
      const tagName = TAG_NAMES[tag] || `Tag_0x${tag.toString(16)}`;
      const value = readTagValue({ tag, type, count, valueOffset });
      if (value !== undefined) {
        sectionData[tagName] = formatNumberArray(value);
      }
      if (tag === 0x8769 && typeof value === 'number') {
        processIfd(tiffBase + value, 'ExifIFD');
      } else if (tag === 0x8825 && typeof value === 'number') {
        processIfd(tiffBase + value, 'GPSIFD');
      }
    }
  }

  function readTagValue({ type, count, valueOffset }) {
    const typeSize = TYPE_SIZES[type];
    if (!typeSize || count <= 0) {
      return undefined;
    }
    const byteLength = typeSize * count;
    let dataOffset;

    if (byteLength <= 4) {
      dataOffset = valueOffset;
    } else {
      const relativeOffset = readUInt32(valueOffset);
      dataOffset = tiffBase + relativeOffset;
    }

    if (dataOffset < 0 || dataOffset + byteLength > buffer.length) {
      return undefined;
    }

    const slice = buffer.subarray(dataOffset, dataOffset + byteLength);
    switch (type) {
      case 1: // BYTE
      case 7: // UNDEFINED
        return Array.from(slice.values());
      case 2: { // ASCII
        const str = slice.toString('utf8').replace(/\0+$/, '').trim();
        return str.length ? str : undefined;
      }
      case 3: { // SHORT
        const values = [];
        for (let i = 0; i < count; i++) {
          values.push(readUInt16(dataOffset + i * 2));
        }
        return count === 1 ? values[0] : values;
      }
      case 4: { // LONG
        const values = [];
        for (let i = 0; i < count; i++) {
          values.push(readUInt32(dataOffset + i * 4));
        }
        return count === 1 ? values[0] : values;
      }
      case 5: { // RATIONAL
        const values = [];
        for (let i = 0; i < count; i++) {
          const numerator = readUInt32(dataOffset + i * 8);
          const denominator = readUInt32(dataOffset + i * 8 + 4);
          values.push(denominator ? numerator / denominator : null);
        }
        return count === 1 ? values[0] : values;
      }
      case 9: { // SLONG
        const values = [];
        for (let i = 0; i < count; i++) {
          values.push(readInt32(dataOffset + i * 4));
        }
        return count === 1 ? values[0] : values;
      }
      case 10: { // SRATIONAL
        const values = [];
        for (let i = 0; i < count; i++) {
          const numerator = readInt32(dataOffset + i * 8);
          const denominator = readInt32(dataOffset + i * 8 + 4);
          values.push(denominator ? numerator / denominator : null);
        }
        return count === 1 ? values[0] : values;
      }
      default:
        return undefined;
    }
  }
}
