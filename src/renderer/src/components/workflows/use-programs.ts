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

/** One ask per program for each app start. Pi reads its providers, so it is not free. */
const modelLists = new Map<WorkflowProgram, Promise<string[]>>();

async function modelsOf(program: WorkflowProgram): Promise<string[]> {
  let list = modelLists.get(program);
  if (!list) {
    list = callWorkflows('models', program);
    // A failed ask can be asked again.
    list.catch(() => modelLists.delete(program));
    modelLists.set(program, list);
  }
  return list;
}

/** The models to offer for a program, or null until the answer comes. */
export function useModels(program: WorkflowProgram): string[] | null {
  const [models, setModels] = useState<{ program: WorkflowProgram; list: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    modelsOf(program)
      .then((list) => {
        if (live) setModels({ program, list });
      })
      .catch(showWorkflowError);
    return () => {
      live = false;
    };
  }, [program]);

  return models?.program === program ? models.list : null;
}
