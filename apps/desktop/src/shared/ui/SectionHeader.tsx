import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function SectionHeader({ title, subtitle, action }: Props) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {subtitle ? <span className="sub">{subtitle}</span> : null}
      {action}
    </div>
  );
}
