// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// run(input) returns exactly csv-reader 1.0.0's {columns, rows, errors} for
// input {text, header}, following its broken-row policy character for character:
// BOM dropped, empty lines are no record, stray CR dropped (stray_cr), quoted
// fields with "" escapes and CRLF/lone-CR read as LF, junk after a closing
// quote appended (quote_junk at field end), unterminated quote read again as
// unquoted (unterminated_quote), rows padded/cut to the first record's width
// (short_row/long_row at record end), errors {code,line,row} in order met.
//
// Speed: fields are sliced out of the input string instead of being built a
// character at a time; string segments are only joined when a field actually
// needs a transform (escaped quotes, CR normalisation, stray CR removal).
// Fresh unquoted fields use a reader without prefix bookkeeping, and a clean
// quoted field (first quote closes it, no CR inside) is taken with one
// indexOf plus bounded checks on its slice; anything else uses the exact
// per-character logic. No state is kept between calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Field result, written by the readers below (avoids a result object per field).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `prefix` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr). Sets fValue,
  // fEnded and fAdded (characters kept from the scanned region).
  function readUnquoted(prefix) {
    const start = pos;
    let i = pos;
    let segStart = start;
    let parts = null;
    let stray = 0;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ,
        pos = i + 1;
        fEnded = COMMA;
        break;
      }
      if (c === 10) { // \n
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
        break;
      }
      if (c === 13) { // \r
        if (text.charCodeAt(i + 1) === 10) {
          pos = i + 2;
          line += 1;
          fEnded = LINE_BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        stray += 1;
        if (parts === null) parts = [];
        if (i > segStart) parts.push(text.slice(segStart, i));
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    if (i >= len) {
      pos = len;
      fEnded = END;
    }
    fAdded = (i - start) - stray;
    if (parts === null) {
      const seg = text.slice(start, i);
      fValue = prefix === '' ? seg : prefix + seg;
    } else {
      if (i > segStart) parts.push(text.slice(segStart, i));
      const joined = parts.join('');
      fValue = prefix === '' ? joined : prefix + joined;
    }
  }


  // Fresh-field unquoted reader: no prefix, no fAdded bookkeeping.
  function readUnquotedFresh() {
    const start = pos;
    let i = pos;
    let segStart = start;
    let parts = null;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        pos = i + 1;
        fEnded = COMMA;
        break;
      }
      if (c === 10) {
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          pos = i + 2;
          line += 1;
          fEnded = LINE_BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        if (i > segStart) parts.push(text.slice(segStart, i));
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    if (i >= len) {
      pos = len;
      fEnded = END;
    }
    if (parts === null) {
      fValue = text.slice(start, i);
    } else {
      if (i > segStart) parts.push(text.slice(segStart, i));
      fValue = parts.join('');
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    // Fast path: first quote after the opener closes the field, and the
    // sliced content has no CR (LF count is taken on the slice, bounded).
    {
      const start = pos + 1;
      const q = text.indexOf('"', start);
      if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
        const value = text.slice(start, q);
        if (!value.includes('\r')) {
          let nl = 0;
          let s = 0;
          while (true) {
            const lf = value.indexOf('\n', s);
            if (lf === -1) break;
            nl += 1;
            s = lf + 1;
          }
          pos = q + 1;
          line += nl;
          if (pos >= len) {
            fValue = value;
            fEnded = END;
            return;
          }
          const nc = text.charCodeAt(pos);
          if (nc === 44) {
            pos += 1;
            fValue = value;
            fEnded = COMMA;
            return;
          }
          if (nc === 10) {
            pos += 1;
            line += 1;
            fValue = value;
            fEnded = LINE_BREAK;
            return;
          }
          if (nc === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fValue = value;
            fEnded = LINE_BREAK;
            return;
          }
          readUnquoted(value);
          if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          return;
        }
      }
    }
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let segStart = i;
    let parts = null;
    let newLines = 0;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 34) { // "
        if (text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [];
          if (i > segStart) parts.push(text.slice(segStart, i));
          parts.push('"');
          i += 2;
          segStart = i;
          continue;
        }
        // Closing quote.
        let value;
        if (parts === null) {
          value = text.slice(segStart, i);
        } else {
          if (i > segStart) parts.push(text.slice(segStart, i));
          value = parts.join('');
        }
        pos = i + 1;
        line += newLines;
        if (pos >= len) {
          fValue = value;
          fEnded = END;
          return;
        }
        const nc = text.charCodeAt(pos);
        if (nc === 44) {
          pos += 1;
          fValue = value;
          fEnded = COMMA;
          return;
        }
        if (nc === 10) {
          pos += 1;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          return;
        }
        if (nc === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          return;
        }
        // Junk after the closing quote, appended as it stands.
        readUnquoted(value);
        if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        return;
      }
      if (c === 13) { // CRLF and lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        if (i > segStart) parts.push(text.slice(segStart, i));
        parts.push('\n');
        newLines += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        segStart = i;
        continue;
      }
      if (c === 10) newLines += 1;
      i += 1;
    }
    // The quote never closes: it is a literal character, and the text after
    // it is read again as unquoted. Tentative line counting is discarded.
    pos = open + 1;
    line = openLine;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    readUnquoted('"');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquotedFresh();
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
