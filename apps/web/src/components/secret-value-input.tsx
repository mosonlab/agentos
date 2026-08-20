import type { ComponentProps, ReactNode } from "react";

import { Input } from "./ui/input";

export const SecretValueInput = (props: Omit<ComponentProps<"input">, "type">): ReactNode => (
  <Input type="password" {...props} />
);
