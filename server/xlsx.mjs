/**
 * Minimal .xlsx reader - enough to pull cell values out of a workbook, with no
 * dependencies.
 *
 * An .xlsx is a ZIP of XML parts. Node ships zlib but no ZIP reader, so this
 * walks the ZIP central directory itself (which always carries correct sizes and
 * offsets, unlike local headers on streamed archives) and inflates the parts it
 * needs.
 *
 * Scope: cell values, shared strings, inline strings, and the 1900-system date
 * serials Excel writes. Not styles, formulas, merged cells or charts - this
 * reads data, it does not render spreadsheets.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/** Read every entry of a ZIP into a Map of name -> Buffer. */
function unzip(buf) {
  // The end-of-central-directory record sits in the last 64KB, after a variable
  // length comment, so it has to be found by scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and has its own extra field, whose
    // length can differ from the central one - so read it, do not assume.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });

/** Column letters to a 1-based index: A -> 1, AB -> 28. */
export function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Excel's 1900 date system, including the deliberate 1900-02-29 bug: serials
 * are counted from 1899-12-30 so that everything from 1900-03-01 lines up.
 */
export function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Read a workbook into [{ name, rows: [[cell, ...], ...] }]. */
export function readWorkbook(path) {
  const files = unzip(readFileSync(path));
  const text = (name) => (files.has(name) ? files.get(name).toString('utf8') : null);

  // Shared strings: each <si> may hold several <t> runs that concatenate.
  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) {
    for (const [, si] of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let s = '';
      for (const [, run] of si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unescapeXml(run);
      shared.push(s);
    }
  }

  const wb = text('xl/workbook.xml') || '';
  const relsXml = text('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  for (const [, id, target] of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(id, target);
  }

  const sheets = [];
  for (const [, attrs] of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(attrs)?.[1] || '');
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1];
    let target = rels.get(rid) || '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    const xml = text(target);
    if (xml === null) continue;

    const rows = [];
    for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const [, cAttrs, cBody] of rowXml.matchAll(
        /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g,
      )) {
        const ref = /r="([A-Z]+\d+)"/.exec(cAttrs)?.[1];
        const type = /t="([^"]+)"/.exec(cAttrs)?.[1];
        const body = cBody || '';
        let value = null;
        if (type === 'inlineStr') {
          let s = '';
          for (const [, run] of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unescapeXml(run);
          value = s;
        } else {
          const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (v !== undefined) {
            value = type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(v);
          }
        }
        if (value === null || value === '') continue;
        cells[colIndex(ref || 'A1') - 1] = value;
      }
      rows.push(cells);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
