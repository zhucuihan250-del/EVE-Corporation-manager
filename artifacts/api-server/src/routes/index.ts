import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import charactersRouter from "./characters";
import fleetsRouter from "./fleets";
import papRouter from "./pap";
import rewardsRouter from "./rewards";
import redemptionsRouter from "./redemptions";
import dashboardRouter from "./dashboard";
import announcementsRouter from "./announcements";
import battleReportsRouter from "./battle-reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(charactersRouter);
router.use(fleetsRouter);
router.use(papRouter);
router.use(rewardsRouter);
router.use(redemptionsRouter);
router.use(dashboardRouter);
router.use(announcementsRouter);
router.use(battleReportsRouter);

export default router;
