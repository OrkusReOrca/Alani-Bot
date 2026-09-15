"""Shared py-feat detector — one face-detection pass per clip serves AU,
eye gaze, AND head pose (extract_au.py / extract_pose.py both format
columns out of the same result), instead of each extractor running its
own separate detection pass over the same frames. On a CPU-only host,
running face detection twice per clip for no reason is exactly the kind
of wasted compute worth avoiding.

face_model="img2pose" is chosen specifically because methodology.txt
names img2pose as the head-pose estimator; it doubles as the face
detector for this pass (py-feat auto-selects the matching facepose model
for whichever face_model is chosen), and doesn't affect gaze (gaze_model
defaults to "l2cs", independent of face_model) or AU (au_model defaults
to "xgb", also independent).
"""

_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        from feat import Detectorv1

        _detector = Detectorv1(face_model="img2pose")
    return _detector


def detect_frames(frame_paths):
    """One py-feat pass over the given frames -> the Fex result
    dataframe, used by both extract_au.py and extract_pose.py."""
    return _get_detector().detect(inputs=frame_paths, data_type="image")
