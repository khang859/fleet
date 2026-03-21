import type { ServiceRegistry } from './socket-server'
import type { StarbaseRuntimeClient } from './starbase-runtime-client'

export function createSocketRuntimeServices(runtime: StarbaseRuntimeClient): ServiceRegistry {
  return {
    crewService: {
      listCrew: (filter?: unknown) => runtime.invoke('crew.list', filter),
      deployCrew: (opts: unknown) => runtime.invoke('crew.deploy', opts),
      recallCrew: (crewId: string) => runtime.invoke('crew.recall', crewId),
      getCrewStatus: (crewId: string) => runtime.invoke('crew.status', crewId),
      observeCrew: (crewId: string) => runtime.invoke('crew.observe', crewId),
      messageCrew: (crewId: string, message: string) =>
        runtime.invoke('crew.message', { crewId, message }),
    } as unknown as ServiceRegistry['crewService'],
    missionService: {
      addMission: (opts: unknown) => runtime.invoke('mission.add', opts),
      listMissions: (filter?: unknown) => runtime.invoke('mission.list', filter),
      getMission: (missionId: number) => runtime.invoke('mission.get', missionId),
      updateMission: (missionId: number, fields: Record<string, string>) =>
        runtime.invoke('mission.update', { missionId, fields }),
      setStatus: (missionId: number, status: string) =>
        runtime.invoke('mission.setStatus', { missionId, status }),
      resetForRequeue: (missionId: number) => runtime.invoke('mission.resetForRequeue', missionId),
      abortMission: (missionId: number) => runtime.invoke('mission.abort', missionId),
      setReviewVerdict: (missionId: number, verdict: string, notes: string) =>
        runtime.invoke('mission.setReviewVerdict', { missionId, verdict, notes }),
      getDependencies: (missionId: number) => runtime.invoke('mission.getDependencies', missionId),
    } as unknown as ServiceRegistry['missionService'],
    commsService: {
      getUnreadByExecution: (executionId: string) =>
        runtime.invoke('comms.getUnreadByExecution', executionId),
      getRecent: (opts?: unknown) => runtime.invoke('comms.getRecent', opts),
      markRead: (id: number) => runtime.invoke('comms.markRead', id),
      send: (opts: unknown) => runtime.invoke('comms.send', opts),
      delete: (id: number) => runtime.invoke('comms.delete', id),
      clear: (opts?: unknown) => runtime.invoke('comms.clear', opts),
      markAllRead: (opts?: unknown) => runtime.invoke('comms.markAllRead', opts),
      getTransmission: (id: number) => runtime.invoke('comms.getTransmission', id),
      getUnread: (crewId: string) => runtime.invoke('comms.getUnread', crewId),
      resolve: (id: number, response: string) => runtime.invoke('comms.resolve', { id, response }),
    } as unknown as ServiceRegistry['commsService'],
    sectorService: {
      listVisibleSectors: () => runtime.invoke('sector.listVisible'),
      getSector: (sectorId: string) => runtime.invoke('sector.get', sectorId),
      addSector: (opts: unknown) => runtime.invoke('sector.add', opts),
      removeSector: (sectorId: string) => runtime.invoke('sector.remove', sectorId),
    } as unknown as ServiceRegistry['sectorService'],
    cargoService: {
      listCargo: (filter?: unknown) => runtime.invoke('cargo.list', filter),
      getCargo: (id: number) => runtime.invoke('cargo.get', id),
      produceCargo: (opts: unknown) => runtime.invoke('cargo.produce', opts),
      getUndelivered: (sectorId: string) => runtime.invoke('cargo.getUndelivered', sectorId),
    } as unknown as ServiceRegistry['cargoService'],
    supplyRouteService: {
      listRoutes: () => runtime.invoke('supplyRoute.list'),
      addRoute: (opts: unknown) => runtime.invoke('supplyRoute.add', opts),
      removeRoute: (routeId: number) => runtime.invoke('supplyRoute.remove', routeId),
    } as unknown as ServiceRegistry['supplyRouteService'],
    configService: {
      get: (key: string) => runtime.invoke('config.get', key),
      set: (key: string, value: unknown) => runtime.invoke('config.set', { key, value }),
    } as unknown as ServiceRegistry['configService'],
    shipsLog: {
      query: (opts?: unknown) => runtime.invoke('shipsLog.query', opts),
    } as unknown as ServiceRegistry['shipsLog'],
    protocolService: {
      listProtocols: () => runtime.invoke('protocol.list'),
      getProtocolBySlug: (slug: string) => runtime.invoke('protocol.getBySlug', slug),
      listSteps: (protocolId: number) => runtime.invoke('protocol.listSteps', protocolId),
      setProtocolEnabled: (slug: string, enabled: boolean) =>
        runtime.invoke('protocol.setEnabled', { slug, enabled }),
      listExecutions: (status?: string) => runtime.invoke('protocol.listExecutions', status),
      getExecution: (id: string) => runtime.invoke('protocol.getExecution', id),
      advanceStep: (id: string, step: number) => runtime.invoke('protocol.advanceStep', { id, step }),
      updateExecutionStatus: (id: string, status: string) =>
        runtime.invoke('protocol.updateExecutionStatus', { id, status }),
      updateExecutionContext: (id: string, context: string) =>
        runtime.invoke('protocol.updateExecutionContext', { id, context }),
    } as unknown as ServiceRegistry['protocolService'],
  }
}
