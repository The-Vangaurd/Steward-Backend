export function sanitizeCSS(css: string): string {
  return css
    .replace(/@import\b/gi, '/* @import blocked */')
    .replace(/expression\s*\(/gi, '/* expression() blocked */')
    .replace(/url\s*\(\s*(?!["']?data:)(?!["']?#)/gi, 'url(blocked-')
    .replace(/<\/?script/gi, '/* script tag blocked */');
}
