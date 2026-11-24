import { Button, Modal } from '../ui';

export function InfoModal({
  title,
  body,
  primaryLabel,
  onPrimary,
  onClose,
}: {
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <span className="modal__foot-spacer" />
          <Button variant="primary" onClick={onPrimary}>
            {primaryLabel}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
        {body}
      </p>
    </Modal>
  );
}
