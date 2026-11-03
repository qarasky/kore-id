import { Button, Checkbox, Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, Field, Input, Select } from "@qarasky/kore-ui";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { errorCode, errorMessage } from "../lib/strings";
import type { AdminApp, Role, User } from "../lib/types";
import { SetupLink } from "./parts";

type Errors = { name?: string; email?: string; role?: string; apps?: string; form?: string };

/** "Add user": name, email, role, apps. On success shows the one-time setup link. */
export function AddUserDialog({
  open,
  onOpenChange,
  apps,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: AdminApp[];
  onCreated: (user: User) => void;
}) {
  const [created, setCreated] = useState<{ user: User; setupUrl: string } | null>(null);
  const [role, setRole] = useState<Role>("user");
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  const reset = () => {
    setCreated(null);
    setRole("user");
    setSelected([]);
    setErrors({});
    setPending(false);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const d = new FormData(e.currentTarget);
    const name = String(d.get("name") ?? "").trim();
    const email = String(d.get("email") ?? "").trim();
    const errs: Errors = {};
    if (!name) errs.name = "Enter their name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email, like name@example.com.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setPending(true);
    try {
      const r = await api.createUser({ name, email, role, apps: role === "admin" ? [] : selected });
      setCreated(r);
      onCreated(r.user);
    } catch (err) {
      const code = errorCode(err);
      const msg = errorMessage(err);
      if (code === "email_taken" || code === "invalid_email") setErrors({ email: msg });
      else if (code === "invalid_name") setErrors({ name: msg });
      else if (code === "invalid_role") setErrors({ role: msg });
      else if (code === "invalid_apps") setErrors({ apps: msg });
      else setErrors({ form: msg });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent
        title={created ? `${created.user.name} was added` : "Add user"}
        description={
          created
            ? "Copy the setup link now. It isn't shown again."
            : "They choose their own password from a one-time setup link."
        }
      >
        {created ? (
          <>
            <DialogBody>
              <SetupLink url={created.setupUrl} name={created.user.name} />
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="primary">Done</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} noValidate>
            <DialogBody className="flex flex-col gap-4">
              <Field label="Name" error={errors.name} required>
                <Input name="name" autoComplete="off" maxLength={100} />
              </Field>
              <Field label="Email" hint="Their sign-in name. Only admins can change it later." error={errors.email} required>
                <Input name="email" type="email" autoComplete="off" />
              </Field>
              <Field label="Role" error={errors.role}>
                <Select<Role>
                  value={role}
                  onValueChange={setRole}
                  options={[
                    { value: "user", label: "User" },
                    { value: "admin", label: "Admin" },
                  ]}
                />
              </Field>
              <fieldset className="flex flex-col gap-0.5" aria-describedby={errors.apps ? "add-user-apps-error" : undefined}>
                <legend className="mb-1.5 text-meta font-medium text-muted">Apps</legend>
                {role === "admin" ? <p className="mb-1 text-meta text-muted">Admins can use every app.</p> : null}
                {apps.map((a) => (
                  <Checkbox
                    key={a.app}
                    label={a.name}
                    disabled={role === "admin"}
                    checked={role === "admin" || selected.includes(a.app)}
                    onCheckedChange={(c) =>
                      setSelected((s) => (c === true ? [...new Set([...s, a.app])] : s.filter((x) => x !== a.app)))
                    }
                  />
                ))}
                {apps.length === 0 ? <p className="text-meta text-muted">No apps are registered yet.</p> : null}
                {errors.apps ? (
                  <p id="add-user-apps-error" role="alert" className="text-meta text-danger">
                    {errors.apps}
                  </p>
                ) : null}
              </fieldset>
              {errors.form ? (
                <p role="alert" className="text-meta text-danger">
                  {errors.form}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" loading={pending}>
                {pending ? "Adding…" : "Add user"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
