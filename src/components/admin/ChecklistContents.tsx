'use client';

import type { ChecklistTemplate } from '@/domain';

const HEADER_SOURCE_NOTE = 'filled from the job';

/**
 * A CHECKLIST VERSION, ROW FOR ROW, AS ITS SOURCE PRINTS IT. CHK-SRC-1.
 *
 * Read-only: what the office inspects to check the system against the paper —
 * the printed title, header lines, every row with its own number, the group a
 * row sits under, the blanks in its Comments column, what the transcription
 * says about its source (a handwritten line is marked so), and the printed
 * notes and sign-off. Nothing here is generated or reworded.
 */
export const ChecklistContents = ({ template }: { readonly template: ChecklistTemplate }) => {
  const layout = template.layout ?? null;
  return (
    <div className="space-y-4 text-sm" data-testid={`checklist-contents-${template.kind ?? template.id}`}>
      {layout !== null && (
        <div>
          {layout.letterhead.length > 0 && (
            <p className="text-xs text-steel-500">{layout.letterhead}</p>
          )}
          <p className="font-bold tracking-wide text-steel-900" data-testid="checklist-printed-title">
            {layout.title}
          </p>
          <p className="mt-1 text-xs text-steel-500">
            Header: {layout.headerFields.map((field) => field.label).join(' · ')} ({HEADER_SOURCE_NOTE})
          </p>
          <p className="text-xs text-steel-500">
            Columns:{' '}
            {[layout.columns.number, layout.columns.description, layout.columns.tick, layout.columns.comments]
              .map((heading) => (heading.length === 0 ? '(blank)' : heading))
              .join(' · ')}
          </p>
        </div>
      )}

      {template.sections.map((section) => (
        <div key={section.id}>
          {section.title.length > 0 && (
            <p className="border-b border-steel-200 pb-1 text-xs font-bold tracking-wide text-steel-700">
              {section.title}
            </p>
          )}
          <ol className="divide-y divide-steel-100">
            {section.items.map((item, index) => {
              const group = item.group ?? '';
              const firstOfGroup = group.length > 0 && (section.items[index - 1]?.group ?? '') !== group;
              return (
                <li key={item.id} className="py-1.5" data-testid="checklist-contents-item">
                  {firstOfGroup && (
                    <p className="flex gap-2 font-semibold text-steel-900">
                      <span className="tabular w-6 shrink-0 text-steel-500">{item.number}</span>
                      {group}
                    </p>
                  )}
                  <p className="flex gap-2 text-steel-800">
                    <span className="tabular w-6 shrink-0 text-steel-500">
                      {group.length > 0 ? '' : (item.number ?? '')}
                    </span>
                    <span className={group.length > 0 ? 'whitespace-pre-line pl-4' : 'whitespace-pre-line'}>
                      {item.text}
                    </span>
                  </p>
                  {(item.fields ?? []).length > 0 && (
                    <p className="ml-8 text-xs text-steel-500">
                      {(item.fields ?? [])
                        .map((field) => [field.label, '___', field.unit].filter((part) => part.length > 0).join(' '))
                        .join('   ')}
                    </p>
                  )}
                  {(item.sourceNote ?? '').length > 0 && (
                    <p className="ml-8 text-xs font-medium text-amber-eje-800 italic">{item.sourceNote}</p>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ))}

      {layout !== null && (
        <div className="space-y-1 border-t border-steel-100 pt-2 text-xs text-steel-600">
          {layout.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {layout.closing.length > 0 && <p className="font-bold text-steel-900">{layout.closing}</p>}
          <p>Sign-off: {layout.signatures.map((line) => line.label).join(' · ')}</p>
        </div>
      )}
    </div>
  );
};
