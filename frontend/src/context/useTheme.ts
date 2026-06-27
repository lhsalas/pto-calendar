import { useContext } from 'react';
import { ThemeContext } from './themeContextValue';

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return value;
}
