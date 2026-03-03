import { useEffect, useState } from "react";

export const useSimulatedLoading = (ms = 800): { isLoading: boolean } => {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    const timeoutId = window.setTimeout(() => setIsLoading(false), ms);
    return () => window.clearTimeout(timeoutId);
  }, [ms]);

  return { isLoading };
};

