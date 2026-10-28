import { flatRoutes } from "@react-router/fs-routes";

// Tests can sit next to their route without becoming routes.
export default flatRoutes({ ignoredRouteFiles: ["**/*.test.*"] });
