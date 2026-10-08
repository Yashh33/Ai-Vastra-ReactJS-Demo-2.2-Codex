type Props = {
  /** True while a just-picked photo is being decoded / compressed. */
  preparing: boolean;
  /** Message to show when the photo could not be read. */
  error?: string | null;
};

/** Feedback shown next to a photo picker: a spinner while preparing, or the read error. */
export function PhotoPickStatus({ preparing, error }: Props) {
  if (preparing) {
    return (
      <div className="photo-pick-status" role="status">
        <div className="spinner spinner-small" />
        <span>Preparing photo…</span>
      </div>
    );
  }
  if (error) {
    return (
      <p className="error-text" role="alert">
        {error}
      </p>
    );
  }
  return null;
}
