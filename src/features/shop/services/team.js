// The shop's team (members, roles, enrolled phones) is reached through the "teamService" port (contract: shared/di/ports.js,
// implementation: infrastructure/team/team-client.js, provided by app/container.js).
import { use } from '../../../shared/di/services.js';

export const teamService = () => use("teamService");
