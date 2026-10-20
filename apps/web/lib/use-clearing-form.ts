"use client";

import { startTransition, useEffect, useRef, type FormEvent } from "react";

/**
 * Submits through onSubmit so a failed save keeps what the person typed (React's automatic reset
 * is skipped), and clears the form and focuses the confirmation after each success. Controlled
 * fields reset their own state from the form's onReset.
 */
export function useClearingForm(
  done: { id: string } | undefined,
  formAction: (data: FormData) => void,
) {
  const formRef = useRef<HTMLFormElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  // Keyed on the created record's id, so a second success with the same label still clears.
  const doneId = done?.id;
  useEffect(() => {
    if (doneId) {
      formRef.current?.reset();
      doneRef.current?.focus();
    }
  }, [doneId]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return { formRef, doneRef, onSubmit };
}
