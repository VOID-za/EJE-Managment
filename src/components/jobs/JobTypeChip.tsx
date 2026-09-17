import { getJobTypeDefinition, type JobTypeCode } from '@/domain';
import { Badge, type BadgeTone } from '@/components/ui';

const ACCENT_TO_TONE: Record<string, BadgeTone> = {
  red: 'red',
  blue: 'blue',
  green: 'green',
  violet: 'violet',
};

export const JobTypeChip = ({
  jobType,
  size = 'md',
}: {
  readonly jobType: JobTypeCode;
  readonly size?: 'sm' | 'md';
}) => {
  const definition = getJobTypeDefinition(jobType);
  return (
    <Badge tone={ACCENT_TO_TONE[definition.accent] ?? 'neutral'} size={size}>
      {definition.label}
    </Badge>
  );
};
