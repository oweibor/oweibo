import type { ReactNode } from 'react';

interface PageHeaderProps {
  title:       string;
  subtitle?:   string;
  actions?:    ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div style={{
      display:        'flex',
      alignItems:     'center',
      marginBottom:   '1.5rem',
      paddingBottom:  '0.75rem',
      borderBottom:   '1px solid #e5e5e5',
    }}>
      <div style={{ flex: 1 }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{title}</h1>
        {subtitle && <p style={{ margin: '0.25rem 0 0', color: '#666', fontSize: 14 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: '0.5rem' }}>{actions}</div>}
    </div>
  );
}
