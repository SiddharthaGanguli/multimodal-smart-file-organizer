import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { validateFile } from "../src/validation.js";

const MAX_BYTES = 20 * 1024 * 1024;
const makeFile = (content, name = "notes.txt", type = "") => new File([content], name, { type });

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function docx({ deflate = false, descriptor = false, descriptorSignature = true, encrypted = false, names = ["[Content_Types].xml", "word/document.xml"] } = {}) {
  const locals = [];
  const directories = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name);
    const original = Buffer.from("<?xml version=\"1.0\"?><document>Hello</document>");
    const compressed = deflate ? deflateRawSync(original) : original;
    const checksum = crc32(original);
    const flags = (descriptor ? 8 : 0) | (encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    if (!descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(original.length, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    let suffix = Buffer.alloc(0);
    if (descriptor) {
      suffix = Buffer.alloc(descriptorSignature ? 16 : 12);
      const start = descriptorSignature ? 4 : 0;
      if (descriptorSignature) suffix.writeUInt32LE(0x08074b50, 0);
      suffix.writeUInt32LE(checksum, start);
      suffix.writeUInt32LE(compressed.length, start + 4);
      suffix.writeUInt32LE(original.length, start + 8);
    }
    const record = Buffer.concat([local, filename, compressed, suffix]);
    locals.push(record);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(original.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directories.push(Buffer.concat([central, filename]));
    offset += record.length;
  }
  const directory = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("returns safe metadata and the preserved original's SHA-256", async () => {
  const bytes = Buffer.from("hello smart file organizer\n");
  const result = await validateFile(makeFile(bytes, "..\\private/notes.TXT", "image/png"));
  assert.deepEqual(result, {
    name: "notes.TXT",
    extension: ".txt",
    mimeType: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

test("accepts a file exactly at the default 20 MB limit", async () => {
  const bytes = Buffer.alloc(MAX_BYTES, 0x61);
  const result = await validateFile(makeFile(bytes));
  assert.equal(result.size, MAX_BYTES);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("rejects an oversized file before opening its stream", async () => {
  const file = makeFile(Buffer.alloc(MAX_BYTES + 1, 0x61));
  file.stream = () => { throw new Error("Oversized file must not be read"); };
  await assert.rejects(validateFile(file), /20 MB upload limit/);
});

test("honors a custom size limit", async () => {
  await assert.rejects(validateFile(makeFile("abcd"), { maxBytes: 3 }), /upload limit/);
  assert.equal((await validateFile(makeFile("abc"), { maxBytes: 3 })).size, 3);
});

test("accepts UTF-8 crossing the former 8192-byte sampling boundary", async () => {
  await validateFile(makeFile(Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from("é")])));
});

test("decodes UTF-8 across actual stream chunk boundaries", async () => {
  const file = makeFile("aé界🙂");
  const bytes = new Uint8Array(await file.arrayBuffer());
  file.stream = () => new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const result = await validateFile(file);
  assert.equal(result.size, bytes.length);
});

test("rejects NUL and invalid UTF-8 after the first 8192 bytes", async () => {
  for (const suffix of [Buffer.from([0]), Buffer.from([0xff])]) {
    await assert.rejects(validateFile(makeFile(Buffer.concat([Buffer.alloc(8192, 0x61), suffix]))), /UTF-8 text without binary data/);
  }
});

test("rejects an incomplete final UTF-8 code point", async () => {
  await assert.rejects(validateFile(makeFile(Buffer.from([0x61, 0xc3]))), /UTF-8/);
});

test("rejects empty and unsupported files", async () => {
  await assert.rejects(validateFile(makeFile("")), /Empty files/);
  await assert.rejects(validateFile(makeFile("payload", "archive.exe")), /Choose a PDF/);
});

test("checks PDF, JPEG and PNG signatures independently of supplied MIME type", async () => {
  for (const [name, bytes, mimeType] of [
    ["document.pdf", Buffer.from("%PDF-1.7\n"), "application/pdf"],
    ["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["photo.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe1]), "image/jpeg"],
    ["image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
  ]) {
    assert.equal((await validateFile(makeFile(bytes, name, "text/plain"))).mimeType, mimeType);
    await assert.rejects(validateFile(makeFile("fake file", name, mimeType)), /content is not/);
  }
});

test("accepts stored and ordinary deflated DOCX archives", async () => {
  for (const deflate of [false, true]) {
    const result = await validateFile(makeFile(docx({ deflate }), "report.docx"));
    assert.equal(result.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }
});

test("accepts streaming ZIP data descriptors with and without a signature", async () => {
  for (const descriptorSignature of [false, true]) {
    await validateFile(makeFile(docx({ deflate: true, descriptor: true, descriptorSignature }), "report.docx"));
  }
});

test("rejects fake or truncated ZIP directories with user-friendly errors", async () => {
  const endOnly = Buffer.alloc(22);
  endOnly.writeUInt32LE(0x06054b50, 0);
  endOnly.writeUInt32LE(1, 12);
  const truncated = docx().subarray(0, -1);
  const corrupt = docx();
  const directoryOffset = corrupt.readUInt32LE(corrupt.length - 6);
  corrupt[directoryOffset] = 0;
  for (const bytes of [Buffer.from("not a ZIP"), endOnly, truncated, corrupt]) {
    await assert.rejects(validateFile(makeFile(bytes, "report.docx")), /DOCX file cannot be opened/);
  }
});

test("rejects inconsistent local headers and out-of-bounds compressed data", async () => {
  const mismatchedName = docx();
  mismatchedName[30] ^= 1;
  const badSize = docx({ deflate: true });
  const directoryOffset = badSize.readUInt32LE(badSize.length - 6);
  badSize.writeUInt32LE(badSize.length, directoryOffset + 20);
  for (const bytes of [mismatchedName, badSize]) {
    await assert.rejects(validateFile(makeFile(bytes, "report.docx")), /DOCX file cannot be opened/);
  }
});

test("rejects encrypted archives and missing or duplicate required entries", async () => {
  await assert.rejects(validateFile(makeFile(docx({ encrypted: true }), "report.docx")), /encrypted/);
  await assert.rejects(validateFile(makeFile(docx({ names: ["word/document.xml"] }), "report.docx")), /required Word document entries are missing/);
  await assert.rejects(validateFile(makeFile(docx({ names: ["[Content_Types].xml", "word/document.xml", "word/document.xml"] }), "report.docx")), /duplicate/);
});

test("rejects unsafe ZIP names and unsupported ZIP64 directories", async () => {
  await assert.rejects(validateFile(makeFile(docx({ names: ["[Content_Types].xml", "word/document.xml", "../escape"] }), "report.docx")), /unsafe/);
  const zip64 = docx();
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  await assert.rejects(validateFile(makeFile(zip64, "report.docx")), /ZIP64/);
});
