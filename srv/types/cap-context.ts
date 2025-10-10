export interface CapRequestUser {
  id?: string;
  name?: string;
  tenant?: string;
}

export interface CapRequestContext {
  user?: CapRequestUser | null;
  tenant?: string;
  locale?: string;
}
