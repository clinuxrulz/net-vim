
const modules = import.meta.glob('./prelude/*.{ts,tsx,txt,md}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const PRELUDE_PLUGINS: Record<string, string> = Object.entries(modules).reduce(
  (acc, [path, content]) => {
    const fileName = path.split('/').pop()!;
    if (fileName === 'index.ts') return acc;
    acc[fileName] = content as string;
    return acc;
  },
  {} as Record<string, string>
);
