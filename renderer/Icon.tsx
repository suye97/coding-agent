const paths = {
  search: 'M16 16l4 4M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  settings: 'M4 7h8m4 0h4M4 17h4m4 0h8M16 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM12 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  branch: 'M6 8v8m12-8v2a8 8 0 0 1-8 8H8M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  close: 'M6 6l12 12M18 6 6 18',
}

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
}
