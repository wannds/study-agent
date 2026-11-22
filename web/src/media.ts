export const localImage = (src?: string) => !!src && /^\/api\/video\/assets\/[a-zA-Z0-9-]+\/frames\/[a-zA-Z0-9_./%-]+$/.test(src);
