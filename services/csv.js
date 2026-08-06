// services/csv.js — CSV for Danish Excel: UTF-8 BOM + semicolon separator,
// which is what da-DK Excel expects when opening a file by double-click.
'use strict';

const BOM = '﻿';
const SEP = ';';

/**
 * Escape one cell.
 * Values starting with = + - @ are prefixed with an apostrophe: a spreadsheet
 * would otherwise evaluate them as formulas, and this data comes from an
 * external registry and from free-text notes.
 */
function cell(value) {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/["\n\r;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {object[]} rows
 * @param {Array<[string, string]>} columns  [dbKey, header] pairs, in order
 */
function toCsv(rows, columns) {
  const lines = [columns.map(([, header]) => cell(header)).join(SEP)];
  for (const row of rows) {
    lines.push(columns.map(([key]) => cell(row[key])).join(SEP));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv };
