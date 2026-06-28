import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ListIcon,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Sun,
  X,
} from '../../src/components/icons';

describe('icons barrel', () => {
  const icons = {
    ChevronLeft,
    ChevronRight,
    X,
    Plus,
    Sun,
    Moon,
    Monitor,
    CalendarIcon,
    ListIcon,
    LogOut,
  };

  for (const [name, Icon] of Object.entries(icons)) {
    it(`${name} renders an svg`, () => {
      const { container } = render(<Icon aria-label={name} />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('aria-label')).toBe(name);
    });
  }
});
