import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';

/**
 * Artifact builders. Draft format (from GENERATING) is a plain object:
 *   { title, sections: [{ heading, paragraphs: [...] , bullets: [...] }] }
 * Markdown renders directly; docx maps headings/paragraphs/bullets.
 */

function draftToMarkdown(draft) {
  const lines = [];
  lines.push(`# ${draft.title || 'Untitled'}`, '');
  for (const section of draft.sections || []) {
    if (section.heading) lines.push(`## ${section.heading}`, '');
    for (const p of section.paragraphs || []) lines.push(p, '');
    for (const b of section.bullets || []) lines.push(`- ${b}`);
    if (section.bullets?.length) lines.push('');
  }
  return lines.join('\n');
}

export async function buildDocxDraft(draft) {
  const children = [];
  children.push(new Paragraph({ text: draft.title || 'Untitled', heading: HeadingLevel.TITLE }));
  for (const section of draft.sections || []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const p of section.paragraphs || []) {
      children.push(new Paragraph({ children: [new TextRun(p)] }));
    }
    for (const b of section.bullets || []) {
      children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildArtifact({ capability, draft }) {
  if (capability.artifact.ext === 'docx') {
    const buf = await buildDocxDraft(draft);
    return { content: buf, mimeType: capability.artifact.mimeType };
  }
  return { content: Buffer.from(draftToMarkdown(draft), 'utf8'), mimeType: 'text/markdown' };
}

export function draftToMarkdownExport(draft) {
  return draftToMarkdown(draft);
}
