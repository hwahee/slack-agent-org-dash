/**
 * English message catalog — the source of truth for message keys.
 * Every other locale must provide exactly the same keys (enforced by the
 * `Record<MessageKey, string>` annotation on the other catalogs).
 *
 * Interpolation uses `{name}` placeholders, resolved by `translate()`.
 */
export const en = {
  'app.title': 'Bun Fullstack Boilerplate',
  'app.tagline': 'React · Bun · Bun server monorepo starter',

  'nav.designSystem': 'Design System',

  'common.skipToContent': 'Skip to main content',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.delete': 'Delete',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.page': 'Page {page} of {totalPages}',
  'common.previousPage': 'Previous page',
  'common.nextPage': 'Next page',
  'common.theme.light': 'Switch to light theme',
  'common.theme.dark': 'Switch to dark theme',
  'common.design.standard': 'Standard skin',
  'common.design.contrast': 'High-contrast skin (high visibility)',
  'common.design.office': 'Office skin (classic desktop)',
  'common.design.kids': 'Kids skin (playground)',
  'common.language': 'Language',

  'footer.otherServices': 'Other Services',
  'footer.connect': 'Connect',
  'footer.github': 'GitHub',
  'footer.terms': 'Terms of Service',
  'footer.privacy': 'Privacy Policy',
  'footer.copyright': '© {year} {site}',

  'testbed.placeholder.title': 'Testbed',
  'testbed.placeholder.description':
    'The dashboard is not here yet. Operate and observe this testbed through its control plane (/testbed/api).',

  'palette.recent': 'Recently used',
  'palette.hexLabel': 'Hex value',
  'palette.hexInvalid': 'Use a color like #5b5bd6 or #5b5bd680.',
  'palette.customColor': 'More colors (system picker)',
  'palette.contrastWarning': 'Contrast {ratio}:1 — below the {minimum}:1 minimum.',

  'designSystem.title': 'Design System',
  'designSystem.description':
    'Every token and component in one place. Use the footer controls to toggle theme (light/dark), design variant (Standard / Contrast / Office / Kids) and language.',
  'designSystem.colors': 'Color tokens',
  'designSystem.typography': 'Typography',
  'designSystem.buttons': 'Buttons',
  'designSystem.formFields': 'Form fields',
  'designSystem.feedback': 'Feedback',
  'designSystem.dataDisplay': 'Data display',
  'designSystem.disclosure': 'Disclosure (accordion)',
  'designSystem.colorInput': 'Color input (palette)',
  'designSystem.overlays': 'Overlays (modal / sheet / sidebar)',

  'auth.signIn': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.signedInAs': 'Signed in as {name}',
  'auth.signInFailed.title': 'Sign-in did not finish',
  'auth.signInFailed.message':
    'The sign-in was turned down, took too long, or was already used. You are not signed in — please try again.',
  'auth.signInFailed.retry': 'Sign in again',

  'notFound.title': 'Page not found',
  'notFound.goHome': 'Go to home',

  'error.validation': 'The request contains invalid data.',
  'error.unauthorized': 'Please sign in to continue.',
  'error.notFound': 'The requested resource was not found.',
  'error.internal': 'An unexpected error occurred. Please try again.',
  'error.versionMismatch':
    'A new version of the application has been deployed. The page will reload.',
} as const;

export type MessageKey = keyof typeof en;
