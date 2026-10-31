import { useEffect } from "react";
import { useRevalidator } from "react-router";

// Reload the page data every few seconds while something runs in the background.
const usePollWhile = (active: boolean, ms = 3000) => {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, ms);
    return () => clearInterval(timer);
  }, [active, ms, revalidator]);
};

export default usePollWhile;
