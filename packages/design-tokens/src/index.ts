export const palette = {
  ink: '#102839',
  inkSecondary: '#1C3A47',
  teal: '#25BFA9',
  lime: '#D7F36C',
  paper: '#F6F7F4',
  white: '#FFFFFF',
  slate: '#61757B',
  pale: '#E8EEEB',
  rule: '#CFD9D5',
  softTeal: '#D9F2EC',
  tealText: '#087F70',
  warning: '#8A4B00',
  danger: '#B42318',
} as const;

export const spacing = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
export const radius = { card: 16, button: 12, sheet: 24, pill: 999 } as const;
export const touch = { minimum: 48, button: 54 } as const;

export type ColorScheme = 'light' | 'dark';
export const themes = {
  light: {
    background: palette.paper,
    surface: palette.white,
    surfaceRaised: palette.white,
    text: palette.ink,
    secondary: palette.slate,
    tealText: palette.tealText,
    border: palette.rule,
    primary: palette.teal,
    primaryText: palette.ink,
    tint: palette.softTeal,
    warning: palette.warning,
    danger: palette.danger,
    lime: palette.lime,
  },
  dark: {
    background: palette.ink,
    surface: palette.inkSecondary,
    surfaceRaised: '#244A56',
    text: palette.paper,
    secondary: '#B7C8C6',
    tealText: '#57DCC7',
    border: '#45616A',
    primary: palette.teal,
    primaryText: palette.ink,
    tint: '#214E50',
    warning: '#FFD08A',
    danger: '#FFAAA4',
    lime: palette.lime,
  },
} as const;

export type Theme = (typeof themes)[ColorScheme];
