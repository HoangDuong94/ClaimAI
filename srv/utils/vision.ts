import { readFile } from 'node:fs/promises';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';

export interface VisionResult {
  description: string | null;
  exif: Record<string, unknown>;
  error?: string;
}

const DEFAULT_IMAGE_PROMPT = 'Beschreibe den sichtbaren Schaden in höchstens drei Sätzen. Falls erkennbar: Fahrzeugtyp, betroffene Bauteile, Umfeld. Nutze EXIF-Informationen nicht direkt in deiner Beschreibung.';

const EXIF_TAG_NAMES: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9209: 'Flash',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension'
};

const EXIF_TYPE_SIZES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8
};

const isPng = (buffer: Buffer): boolean => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer.slice(0, 8).equals(pngSignature);
};

const readPngExifChunk = (buffer: Buffer): Buffer | null => {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break;
    if (type === 'eXIf') {
      return buffer.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + 4;
  }
  return null;
};

const parseExifBuffer = (buffer: Buffer): Record<string, unknown> => {
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

  const readUInt16 = (offset: number): number => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const readInt32 = (offset: number): number => (littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset));
  const readUInt32 = (offset: number): number => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));

  const data: Record<string, unknown> = {};
  const firstIfdOffset = readUInt32(tiffBase + 4);
  processIfd(tiffBase + firstIfdOffset, 'IFD0');
  return data;

  function processIfd(offset: number, section: string): void {
    if (!offset || offset < tiffBase || offset >= buffer.length) {
      return;
    }
    if (offset + 2 > buffer.length) {
      return;
    }
    const numEntries = readUInt16(offset);
    let entryOffset = offset + 2;
    for (let i = 0; i < numEntries; i++) {
      if (entryOffset + 12 > buffer.length) break;
      const tag = readUInt16(entryOffset);
      const type = readUInt16(entryOffset + 2);
      const count = readUInt32(entryOffset + 4);
      const valueOffset = entryOffset + 8;
      const valueSize = (EXIF_TYPE_SIZES[type] || 1) * count;
      let dataOffset = valueOffset;
      if (valueSize > 4) {
        const pointer = readUInt32(valueOffset);
        dataOffset = tiffBase + pointer;
      }
      const tagName = EXIF_TAG_NAMES[tag] || `Tag_${tag.toString(16)}`;
      const value = readExifValue(type, count, dataOffset);
      if (value !== undefined) data[`${section}.${tagName}`] = value;
      entryOffset += 12;
    }
    const nextIfdOffset = readUInt32(offset + 2 + numEntries * 12);
    if (nextIfdOffset) {
      processIfd(tiffBase + nextIfdOffset, 'IFD1');
    }
  }

  function readExifValue(type: number, count: number, dataOffset: number): unknown {
    if (dataOffset < 0 || dataOffset >= buffer.length) return undefined;
    switch (type) {
      case 1: {
        const values: number[] = [];
        for (let i = 0; i < count; i++) values.push(buffer[dataOffset + i]);
        return count === 1 ? values[0] : values;
      }
      case 2: {
        return buffer.toString('ascii', dataOffset, dataOffset + count).replace(/\u0000+$/, '');
      }
      case 3: {
        const values: number[] = [];
        for (let i = 0; i < count; i++) values.push(littleEndian ? buffer.readUInt16LE(dataOffset + i * 2) : buffer.readUInt16BE(dataOffset + i * 2));
        return count === 1 ? values[0] : values;
      }
      case 4: {
        const values: number[] = [];
        for (let i = 0; i < count; i++) values.push(littleEndian ? buffer.readUInt32LE(dataOffset + i * 4) : buffer.readUInt32BE(dataOffset + i * 4));
        return count === 1 ? values[0] : values;
      }
      case 5: {
        const values: Array<number | null> = [];
        for (let i = 0; i < count; i++) {
          const numerator = littleEndian ? buffer.readUInt32LE(dataOffset + i * 8) : buffer.readUInt32BE(dataOffset + i * 8);
          const denominator = littleEndian ? buffer.readUInt32LE(dataOffset + i * 8 + 4) : buffer.readUInt32BE(dataOffset + i * 8 + 4);
          values.push(denominator ? numerator / denominator : null);
        }
        return count === 1 ? values[0] : values;
      }
      case 7: {
        return buffer.subarray(dataOffset, dataOffset + count);
      }
      case 9: {
        const values: number[] = [];
        for (let i = 0; i < count; i++) values.push(littleEndian ? buffer.readInt32LE(dataOffset + i * 4) : buffer.readInt32BE(dataOffset + i * 4));
        return count === 1 ? values[0] : values;
      }
      case 10: {
        const values: Array<number | null> = [];
        for (let i = 0; i < count; i++) {
          const numerator = littleEndian ? buffer.readInt32LE(dataOffset + i * 8) : buffer.readInt32BE(dataOffset + i * 8);
          const denominator = littleEndian ? buffer.readInt32LE(dataOffset + i * 8 + 4) : buffer.readInt32BE(dataOffset + i * 8 + 4);
          values.push(denominator ? numerator / denominator : null);
        }
        return count === 1 ? values[0] : values;
      }
      default:
        return undefined;
    }
  }
};

export async function analyzeImageAttachment(
  filePath: string,
  options?: { prompt?: string; modelName?: string; maxTokens?: number }
): Promise<VisionResult> {
  try {
    const buffer = await readFile(filePath);
    const base64Image = buffer.toString('base64');
    const exif = extractExifMetadata(buffer);
    const visionClient = new AzureOpenAiChatClient({
      modelName: options?.modelName || 'gpt-4.1',
      max_tokens: options?.maxTokens ?? 400,
    });

    const systemMessage = {
      role: 'system' as const,
      content: 'Du analysierst Schadenfotos und antwortest kompakt auf Deutsch.'
    };
    const humanMessage = {
      role: 'user' as const,
      content: [
        { type: 'text', text: options?.prompt || DEFAULT_IMAGE_PROMPT },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${base64Image}` }
        }
      ]
    };

    const response = await visionClient.invoke([systemMessage, humanMessage]);
    let description: string | null = null;
    const content = (response as any)?.content;
    if (typeof content === 'string') {
      description = content.trim() || null;
    } else if (Array.isArray(content)) {
      description = content
        .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry) => entry.text as string)
        .join('\n')
        .trim() || null;
    }
    return { description, exif };
  } catch (error: any) {
    return { description: null, exif: {}, error: typeof error?.message === 'string' ? error.message : String(error) };
  }
}

export function extractExifMetadata(buffer: Buffer): Record<string, unknown> {
  if (!isPng(buffer)) return {};
  const exifChunk = readPngExifChunk(buffer);
  if (!exifChunk) return {};
  return parseExifBuffer(exifChunk);
}

