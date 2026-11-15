import Foundation

func mobileOrientationAngle(_ x: Double, _ y: Double, previous: Int?) -> Int? {
  guard x.isFinite, y.isFinite, hypot(x, y) >= 0.5 else { return previous }
  let degrees = (atan2(x, -y) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
  if let previous = previous {
    let distance = abs(degrees - Double(previous))
    if min(distance, 360 - distance) < 60 { return previous }
  }
  return (Int((degrees / 90).rounded()) * 90) % 360
}

