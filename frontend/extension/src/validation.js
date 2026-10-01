const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const MIME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
});

function invalidDocx(detail = "its ZIP directory is damaged") {
  return new Error(`This DOCX file cannot be opened: ${detail}.`);
}

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

async function readBytes(file, maxBytes, isText) {
  const bytes = new Uint8Array(file.size);
  const decoder = isText ? new TextDecoder("utf-8", { fatal: true }) : null;
  let offset = 0;

  function accept(chunk) {
    if (offset + chunk.byteLength > maxBytes || offset + chunk.byteLength > bytes.length) {
      throw new Error("The file is larger than the upload limit or changed while being read.");
    }
    if (decoder) {
      try {
        if (chunk.includes(0)) throw new Error("Binary data");
        decoder.decode(chunk, { stream: true });
      } catch {
        throw new Error("TXT files must contain valid UTF-8 text without binary data.");
      }
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (typeof file.stream === "function") {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accept(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } else {
    accept(new Uint8Array(await file.arrayBuffer()));
  }

  if (offset !== file.size) throw new Error("The file changed while being read. Please select it again.");
  if (decoder) {
    try {
      decoder.decode();
    } catch {
      throw new Error("TXT files must contain valid UTF-8 text without binary data.");
    }
  }
  return bytes;
}

// Inspect ZIP structure without inflating entries, so compressed data cannot
// allocate unbounded memory. This is format validation, not malware scanning.
function validateDocx(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasRoom = (offset, count) => offset >= 0 && offset + count <= bytes.length;
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  let end = -1;

  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalidDocx();

  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw invalidDocx("ZIP64 archives are not supported");
  }
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count) {
    throw invalidDocx("split ZIP archives are not supported");
  }
  if (!count || directoryOffset + directorySize !== end || count * 46 > directorySize) {
    throw invalidDocx();
  }

  const names = new Set();
  const required = new Set(["[Content_Types].xml", "word/document.xml"]);
  const ranges = [];
  let cursor = directoryOffset;

  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw invalidDocx();
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const checksum = u32(cursor + 16);
    const compressedSize = u32(cursor + 20);
    const originalSize = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;

    if (flags & 0x2041) throw invalidDocx("encrypted documents are not supported");
    if (method !== 0 && method !== 8) throw invalidDocx("this ZIP compression method is not supported");
    if (compressedSize === 0xffffffff || originalSize === 0xffffffff || localOffset === 0xffffffff) {
      throw invalidDocx("ZIP64 archives are not supported");
    }
    if (!nameLength || next > end || u16(cursor + 34) !== 0 || (method === 0 && compressedSize !== originalSize)) {
      throw invalidDocx();
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    try {
      // Required DOCX names are ASCII. For legacy ZIP encodings, retain the raw
      // byte identity for duplicate checking without guessing a code page.
      name = flags & 0x0800
        ? new TextDecoder("utf-8", { fatal: true }).decode(nameBytes)
        : Array.from(nameBytes, (value) => String.fromCharCode(value)).join("");
    } catch {
      throw invalidDocx("an entry has an invalid filename");
    }
    if (names.has(name) || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
      throw invalidDocx("an entry has an unsafe or duplicate filename");
    }
    names.add(name);

    if (!hasRoom(localOffset, 30) || localOffset + 30 > directoryOffset || u32(localOffset) !== 0x04034b50) {
      throw invalidDocx();
    }
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (u16(localOffset + 6) !== flags || u16(localOffset + 8) !== method || localNameLength !== nameLength || dataEnd > directoryOffset) {
      throw invalidDocx();
    }
    for (let index = 0; index < nameLength; index += 1) {
      if (bytes[localOffset + 30 + index] !== nameBytes[index]) throw invalidDocx();
    }

    let rangeEnd = dataEnd;
    if (flags & 0x0008) {
      // Data descriptors are normal in DOCX ZIPs written to a stream. Their
      // optional signature is followed by CRC-32 and the two 32-bit sizes.
      const descriptorMatches = (offset) => offset + 12 <= directoryOffset
        && u32(offset) === checksum
        && u32(offset + 4) === compressedSize
        && u32(offset + 8) === originalSize;
      if (dataEnd + 4 <= directoryOffset && u32(dataEnd) === 0x08074b50 && descriptorMatches(dataEnd + 4)) {
        rangeEnd += 16;
      } else if (descriptorMatches(dataEnd)) {
        rangeEnd += 12;
      } else {
        throw invalidDocx();
      }
    } else if (u32(localOffset + 14) !== checksum || u32(localOffset + 18) !== compressedSize || u32(localOffset + 22) !== originalSize) {
      throw invalidDocx();
    }
    if (required.has(name) && originalSize === 0) throw invalidDocx("a required document entry is empty");
    ranges.push([localOffset, rangeEnd]);
    cursor = next;
  }

  if (cursor !== end) throw invalidDocx();
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) throw invalidDocx("ZIP entries overlap");
  }
  if ([...required].some((name) => !names.has(name))) {
    throw invalidDocx("the required Word document entries are missing");
  }
}

/** Validate a selected original without changing its bytes. */
export async function validateFile(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("The upload size limit is invalid.");
  if (!file || typeof file.name !== "string" || typeof file.arrayBuffer !== "function") {
    throw new Error("Please select a file to upload.");
  }
  const name = file.name.replace(/\\/g, "/").split("/").pop().replace(/[\u0000-\u001f\u007f]/g, "");
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (!Object.hasOwn(MIME_TYPES, extension)) {
    throw new Error("Choose a PDF, DOCX, TXT, JPG, JPEG, or PNG file.");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("Empty files cannot be uploaded.");
  if (file.size > maxBytes) throw new Error(`The file exceeds the ${maxBytes / (1024 * 1024)} MB upload limit.`);

  const bytes = await readBytes(file, maxBytes, extension === ".txt");
  if (extension === ".pdf" && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new Error("The file has a PDF extension, but its content is not a PDF.");
  }
  if ((extension === ".jpg" || extension === ".jpeg") && !startsWith(bytes, [0xff, 0xd8, 0xff])) {
    throw new Error("The file has a JPEG extension, but its content is not a JPEG image.");
  }
  if (extension === ".png" && !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    throw new Error("The file has a PNG extension, but its content is not a PNG image.");
  }
  if (extension === ".docx") validateDocx(bytes);

  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  return { name, extension, mimeType: MIME_TYPES[extension], size: bytes.length, sha256 };
}
