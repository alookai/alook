package ai.alook.android

data class WebViewGeometry(val top: Int, val right: Int, val bottom: Int, val left: Int, val viewportWidth: Int, val viewportHeight: Int) {
    fun toJson(windowHeight: Int? = null, windowBottom: Int = 0, viewTop: Int = 0): String {
        val windowFields = if (windowHeight == null) "" else {
            val fullHeight = (windowHeight - viewTop).coerceAtLeast(viewportHeight)
            val fullBottom = (viewTop + fullHeight - (windowHeight - windowBottom)).coerceIn(0, fullHeight - top)
            ",\"windowHeight\":$fullHeight,\"windowBottom\":$fullBottom"
        }
        return "{\"top\":$top,\"right\":$right,\"bottom\":$bottom,\"left\":$left,\"viewportWidth\":$viewportWidth,\"viewportHeight\":$viewportHeight,\"caption\":false$windowFields}"
    }

    companion object {
        fun fromWindow(windowWidth: Int, windowHeight: Int, viewLeft: Int, viewTop: Int, viewWidth: Int, viewHeight: Int,
                       left: Int, top: Int, right: Int, bottom: Int): WebViewGeometry? {
            if (windowWidth <= 0 || windowHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return null
            val safeLeft = (left - viewLeft).coerceIn(0, viewWidth)
            val safeTop = (top - viewTop).coerceIn(0, viewHeight)
            return WebViewGeometry(
                safeTop,
                (viewLeft + viewWidth - (windowWidth - right)).coerceIn(0, viewWidth - safeLeft),
                (viewTop + viewHeight - (windowHeight - bottom)).coerceIn(0, viewHeight - safeTop),
                safeLeft, viewWidth, viewHeight,
            )
        }
    }
}
