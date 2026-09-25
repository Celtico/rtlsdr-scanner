import { Box, Heading, List, Stack, Text } from '@chakra-ui/react';
import { Fragment, type ReactNode } from 'react';

/** Tiny renderer for our own reference notes: headings, bullet lists (one level of nesting), bold and code. */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(<Fragment key={k++}>{s.slice(last, m.index)}</Fragment>);
    const t = m[0];
    if (t.startsWith('**')) out.push(<Text as="b" key={k++}>{t.slice(2, -2)}</Text>);
    else out.push(<Box as="code" key={k++} fontFamily="mono" fontSize="0.9em" bg="bg.subtle" px="1" rounded="sm">{t.slice(1, -1)}</Box>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(<Fragment key={k++}>{s.slice(last)}</Fragment>);
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let list: { text: string; sub: string[] }[] = [];
  const flush = () => {
    if (!list.length) return;
    blocks.push(
      <List.Root key={`l${blocks.length}`} gap="1" pl="4" fontSize="sm">
        {list.map((it, i) => (
          <List.Item key={i}>
            {inline(it.text)}
            {it.sub.length > 0 && (
              <List.Root gap="0.5" pl="4" mt="0.5">{it.sub.map((s, j) => <List.Item key={j}>{inline(s)}</List.Item>)}</List.Root>
            )}
          </List.Item>
        ))}
      </List.Root>,
    );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1]!.length;
      if (level === 1) continue; // the card already has a title
      blocks.push(<Heading key={`h${blocks.length}`} size="sm" mt="2">{inline(h[2]!)}</Heading>);
      continue;
    }
    const sub = line.match(/^\s{2,}[-*]\s+(.*)$/);
    if (sub && list.length) { list[list.length - 1]!.sub.push(sub[1]!); continue; }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) { list.push({ text: li[1]!, sub: [] }); continue; }
    flush();
    blocks.push(<Text key={`p${blocks.length}`} fontSize="sm">{inline(line)}</Text>);
  }
  flush();
  return <Stack gap="2">{blocks}</Stack>;
}
