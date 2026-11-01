import { useEffect, useState } from 'react';
import type { WorkflowProgram } from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError } from '../../store/workflows-store';

export type Programs = Record<WorkflowProgram, boolean>;

const ALL_PROGRAMS: Programs = { pi: true, claude: true };

/** The programs on this computer. Until the answer comes, all of them show. */
export function usePrograms(open = true): Programs {
  const [programs, setPrograms] = useState(ALL_PROGRAMS);

  useEffect(() => {
    if (!open) return;
    callWorkflows('programs').then(setPrograms).catch(showWorkflowError);
  }, [open]);

  return programs;
}
