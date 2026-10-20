package ai.alook.android

data class SystemGestureRegion(val left: Int, val right: Int, val width: Int) {
    fun toJson(): String = "{\"left\":$left,\"right\":$right,\"width\":$width}"

    companion object {
        fun fromWindow(windowWidth: Int, viewLeft: Int, viewWidth: Int, left: Int, right: Int): SystemGestureRegion? {
            if (windowWidth <= 0 || viewWidth <= 0) return null
            return SystemGestureRegion(
                (left - viewLeft).coerceIn(0, viewWidth),
                (viewLeft + viewWidth - (windowWidth - right)).coerceIn(0, viewWidth),
                viewWidth,
            )
        }
    }
}
