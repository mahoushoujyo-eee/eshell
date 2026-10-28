// The overlay state: which modal is open, what it is for, and the
// confirmation a destructive action waits for.
//
// The state holds the request, not the action itself for anything that needs
// the current config — the panel's confirm dialog calls back into the
// controller, which re-reads the config before it writes.

export function createOverlayState(react) {
  const { useCallback, useRef, useState } = react;

  return function useOverlayState() {
    const [modal, setModal] = useState(null);
    const [confirm, setConfirm] = useState(null);
    const [sheet, setSheet] = useState(null);
    // Every modal request carries an id, so a form that is reopened starts
    // from a fresh draft instead of the values the last visit left behind.
    const modalId = useRef(0);

    /** Opens a modal of a kind, with the fields it starts from. */
    const openModal = useCallback((kind, initial = {}) => {
      modalId.current += 1;
      setModal({ kind, id: modalId.current, ...initial });
    }, []);

    const closeModal = useCallback(() => setModal(null), []);

    /**
     * A confirmation. The request carries what the dialog shows; the panel's
     * confirm button calls `runConfirm`, which the controller owns.
     */
    const openConfirm = useCallback((request) => {
      setConfirm({ tone: "danger", confirmLabel: "Confirm", ...request });
    }, []);

    const closeConfirm = useCallback(() => setConfirm(null), []);

    const openSheet = useCallback((request) => setSheet({ ...request }), []);
    const closeSheet = useCallback(() => setSheet(null), []);

    return {
      modal,
      setModal,
      openModal,
      closeModal,
      confirm,
      openConfirm,
      closeConfirm,
      sheet,
      openSheet,
      closeSheet,
    };
  };
}
