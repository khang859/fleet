import { useEffect, useState } from 'react';
import type { AdmiralSettingMark } from '../../../shared/agency-settings';

/**
 * The settings the Admiral changed last and that still hold its value, read
 * again whenever main writes a setting. Agency settings when `repoId` is
 * null; a project's own too when it is set.
 */
export function useAdmiralMarks(repoId: string | null): AdmiralSettingMark[] {
  const [marks, setMarks] = useState<AdmiralSettingMark[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void =>
      void window.fleet.agency.settings.marks(repoId).then((next) => {
        if (live) setMarks(next);
      });
    load();
    const off = window.fleet.agency.onChanged((change) => {
      if (change.settings === true && (repoId === null || change.repoId === repoId)) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [repoId]);
  return marks;
}
