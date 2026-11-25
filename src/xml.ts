// A small streaming XML tokenizer for the file drivers (GPX, Apple Health export.xml). It reads text a chunk at a
// time and yields tags and text, so a 2 GB export never sits in memory. Enough of XML for data files: elements,
// attributes, text, entities, comments, CDATA, processing instructions and a DOCTYPE with an internal subset
// (Apple's export has one). It does not validate.

export type XmlToken =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/** tokens of an XML text stream */
export async function* xmlTokens(text: AsyncIterable<string>): AsyncGenerator<XmlToken> {
  let buf = '';
  for await (const s of text) {
    buf += s;
    let i = 0;
    for (;;) {
      const lt = buf.indexOf('<', i);
      if (lt < 0) {
        // text with no tag after it yet: keep it until the next chunk
        break;
      }
      if (lt > i) {
        const t = buf.slice(i, lt);
        if (t.trim()) yield { type: 'text', text: decodeEntities(t) };
        i = lt;
      }
      let end: number;
      if (buf.startsWith('<!--', i)) {
        end = buf.indexOf('-->', i + 4);
        if (end < 0) break;
        i = end + 3;
        continue;
      }
      if (buf.startsWith('<![CDATA[', i)) {
        end = buf.indexOf(']]>', i + 9);
        if (end < 0) break;
        yield { type: 'text', text: buf.slice(i + 9, end) };
        i = end + 3;
        continue;
      }
      if (buf.startsWith('<!DOCTYPE', i)) {
        // a DOCTYPE may hold an internal subset in [ … ]
        const br = buf.indexOf('[', i);
        const gt = buf.indexOf('>', i);
        if (gt < 0) break;
        if (br >= 0 && br < gt) {
          end = buf.indexOf(']>', br);
          if (end < 0) break;
          i = end + 2;
        } else i = gt + 1;
        continue;
      }
      if (buf.startsWith('<?', i)) {
        end = buf.indexOf('?>', i + 2);
        if (end < 0) break;
        i = end + 2;
        continue;
      }
      // a tag: find its '>' outside quoted attribute values
      let q = '';
      end = -1;
      for (let k = i + 1; k < buf.length; k++) {
        const c = buf[k];
        if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') { end = k; break; }
      }
      if (end < 0) break;
      const body = buf.slice(i + 1, end);
      i = end + 1;
      if (body[0] === '/') { yield { type: 'close', name: body.slice(1).trim() }; continue; }
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const sp = inner.search(/\s/);
      const name = sp < 0 ? inner : inner.slice(0, sp);
      yield { type: 'open', name, attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)), selfClosing };
    }
    buf = buf.slice(i);
    if (buf.length > 16 * 1024 * 1024) throw new Error('A single XML element is larger than 16 MB.');
  }
}
