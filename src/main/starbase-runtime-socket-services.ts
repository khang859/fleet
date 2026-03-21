import type { AsyncServiceRegistry } from './socket-server';
import type { StarbaseRuntimeClient } from './starbase-runtime-client';

export function createSocketRuntimeServices(runtime: StarbaseRuntimeClient): AsyncServiceRegistry {
  return {
    crewService: {
      listCrew: async (filter?: unknown) => runtime.invoke('crew.list', filter),
      deployCrew: async (opts: unknown) => runtime.invoke('crew.deploy', opts),
      recallCrew: async (crewId: string) => runtime.invoke('crew.recall', crewId),
      getCrewStatus: async (crewId: string) => runtime.invoke('crew.status', crewId),
      observeCrew: async (crewId: string) => runtime.invoke('crew.observe', crewId),
      messageCrew: async (crewId: string, message: string) =>
        runtime.invoke('crew.message', { crewId, message })
    },
    missionService: {
      addMission: async (opts: unknown) => runtime.invoke('mission.add', opts),
      listMissions: async (filter?: unknown) => runtime.invoke('mission.list', filter),
      getMission: async (missionId: number) => runtime.invoke('mission.get', missionId),
      updateMission: async (missionId: number, fields: Record<string, unknown>) =>
        runtime.invoke('mission.update', { missionId, fields }),
      setStatus: async (missionId: number, status: string) =>
        runtime.invoke('mission.setStatus', { missionId, status }),
      resetForRequeue: async (missionId: number) =>
        runtime.invoke('mission.resetForRequeue', missionId),
      abortMission: async (missionId: number) => runtime.invoke('mission.abort', missionId),
      setReviewVerdict: async (missionId: number, verdict: string, notes: string) =>
        runtime.invoke('mission.setReviewVerdict', { missionId, verdict, notes }),
      getDependencies: async (missionId: number) =>
        runtime.invoke('mission.getDependencies', missionId)
    },
    commsService: {
      getUnreadByExecution: async (executionId: string) =>
        runtime.invoke('comms.getUnreadByExecution', executionId),
      getRecent: async (opts?: unknown) => runtime.invoke('comms.getRecent', opts),
      markRead: async (id: number) => runtime.invoke('comms.markRead', id),
      send: async (opts: unknown) => runtime.invoke('comms.send', opts),
      delete: async (id: number) => runtime.invoke('comms.delete', id),
      clear: async (opts?: unknown) => runtime.invoke('comms.clear', opts),
      markAllRead: async (opts?: unknown) => runtime.invoke('comms.markAllRead', opts),
      getTransmission: async (id: number) => runtime.invoke('comms.getTransmission', id),
      getUnread: async (crewId: string) => runtime.invoke('comms.getUnread', crewId),
      resolve: async (id: number, response: string) =>
        runtime.invoke('comms.resolve', { id, response })
    },
    sectorService: {
      listVisibleSectors: async () => runtime.invoke('sector.listVisible'),
      getSector: async (sectorId: string) => runtime.invoke('sector.get', sectorId),
      addSector: async (opts: unknown) => runtime.invoke('sector.add', opts),
      removeSector: async (sectorId: string) => runtime.invoke('sector.remove', sectorId)
    },
    cargoService: {
      listCargo: async (filter?: unknown) => runtime.invoke('cargo.list', filter),
      getCargo: async (id: number) => runtime.invoke('cargo.get', id),
      produceCargo: async (opts: unknown) => runtime.invoke('cargo.produce', opts),
      getUndelivered: async (sectorId: string) => runtime.invoke('cargo.getUndelivered', sectorId)
    },
    supplyRouteService: {
      listRoutes: async () => runtime.invoke('supplyRoute.list'),
      addRoute: async (opts: unknown) => runtime.invoke('supplyRoute.add', opts),
      removeRoute: async (routeId: number) => runtime.invoke('supplyRoute.remove', routeId)
    },
    configService: {
      get: async (key: string) => runtime.invoke('config.get', key),
      set: async (key: string, value: unknown) => runtime.invoke('config.set', { key, value })
    },
    shipsLog: {
      query: async (opts?: unknown) => runtime.invoke('shipsLog.query', opts)
    },
    protocolService: {
      listProtocols: async () => runtime.invoke('protocol.list'),
      getProtocolBySlug: async (slug: string) => runtime.invoke('protocol.getBySlug', slug),
      listSteps: async (protocolId: string) => runtime.invoke('protocol.listSteps', protocolId),
      setProtocolEnabled: async (slug: string, enabled: boolean) =>
        runtime.invoke('protocol.setEnabled', { slug, enabled }),
      listExecutions: async (status?: string) => runtime.invoke('protocol.listExecutions', status),
      getExecution: async (id: string) => runtime.invoke('protocol.getExecution', id),
      advanceStep: async (id: string, step: number) =>
        runtime.invoke('protocol.advanceStep', { id, step }),
      updateExecutionStatus: async (id: string, status: string) =>
        runtime.invoke('protocol.updateExecutionStatus', { id, status }),
      updateExecutionContext: async (id: string, context: string) =>
        runtime.invoke('protocol.updateExecutionContext', { id, context })
    }
  };
}
